/**
 * services/turrets.js
 * Stellar Turrets txFunction server for automatic donation matching
 *
 * This service implements a Turrets-compatible txFunction that:
 * 1. Listens for payments to project wallets
 * 2. Checks for active matching offers
 * 3. Submits pre-signed matching transactions from the matcher account
 */

const {
  Server,
  TransactionBuilder,
  Networks,
  Operation,
  Asset,
  Keypair,
} = require("@stellar/stellar-sdk");
const pool = require("../db/pool");
const { metrics } = require("./metrics");

const MATCHING_IDEMPOTENCY_NAMESPACE = "turrets:matching";

// Network configuration
const NETWORK = process.env.STELLAR_NETWORK || "testnet";
const NETWORK_PASSPHRASE =
  NETWORK === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;
const HORIZON_URL =
  process.env.HORIZON_URL || "https://horizon-testnet.stellar.org";
let server;
function getServer() {
  if (!server) {
    server = new Server(HORIZON_URL);
  }
  return server;
}

/**
 * Turrets txFunction entry point for matching donations
 * This function is called by the Turret when a payment is detected
 */
async function matchDonationTxFunction(payment) {
  try {
    const { transaction_hash, from, to, amount, asset_code, asset_type } =
      payment;

    // Only match XLM donations
    if (asset_type !== "native" && asset_code !== "XLM") {
      console.log(`Skipping non-XLM donation: ${asset_code || asset_type}`);
      return { matched: false, reason: "Not an XLM donation" };
    }

    // Find the project by wallet address
    const projectResult = await pool.query(
      "SELECT id, name FROM projects WHERE wallet_address = $1",
      [to],
    );

    if (!projectResult.rows[0]) {
      console.log(`Project not found for wallet: ${to}`);
      return { matched: false, reason: "Project not found" };
    }

    const project = projectResult.rows[0];
    const donationAmount = parseFloat(amount);

    // Check for active matching offers
    const matchesResult = await pool.query(
      `SELECT id, matcher_address, cap_xlm, matched_xlm, multiplier
       FROM donation_matches
       WHERE project_id = $1 AND expires_at > NOW()
       ORDER BY created_at ASC`,
      [project.id],
    );

    if (matchesResult.rows.length === 0) {
      console.log(`No active matching offers for project: ${project.id}`);
      return { matched: false, reason: "No active matching offers" };
    }

    // Process matching offers
    let totalMatched = 0;
    const matchResults = [];

    for (const match of matchesResult.rows) {
      const matchedXlm = parseFloat(match.matched_xlm || "0");
      const capXlm = parseFloat(match.cap_xlm);
      const remaining = capXlm - matchedXlm;

      if (remaining <= 0) continue;

      const matchAmount = Math.min(
        donationAmount * match.multiplier,
        remaining,
      );

      if (matchAmount <= 0) continue;

      // Build and submit the matching payment transaction
      const matchResult = await submitMatchingPayment({
        matcherAddress: match.matcher_address,
        projectWallet: to,
        amount: matchAmount,
        originalTxHash: transaction_hash,
        matchId: match.id,
      });

      if (matchResult.success) {
        if (!matchResult.alreadyProcessed) {
          await recordMatchingDonation({
            projectId: project.id,
            donorAddress: match.matcher_address,
            amount: matchAmount,
            message: `Matching donation for ${from}`,
            txHash: matchResult.txHash,
            matchId: match.id,
          });
          await markMatchingEffectsRecorded(
            transaction_hash,
            match.id,
            matchResult.txHash,
          );
        }

        totalMatched += matchAmount;
        matchResults.push({
          matcherAddress: match.matcher_address,
          amount: matchAmount,
          txHash: matchResult.txHash,
        });
      }
    }

    return {
      matched: totalMatched > 0,
      totalMatched,
      matches: matchResults,
      projectId: project.id,
      projectName: project.name,
    };
  } catch (error) {
    console.error("Error in matchDonationTxFunction:", error);
    return { matched: false, error: error.message };
  }
}

/**
 * Turrets txFunction entry point for matching donations.
 *
 * @param {object} payment - Payment operation object from Horizon/Turret.
 * @returns {Promise<object>} Result describing whether matching occurred and details.
 * @throws {Error} If internal processing fails unexpectedly.
 */
// exported as `matchDonationTxFunction`

/**
 * Submit a matching payment transaction
 * This uses pre-signed transactions from the matcher's account
 */
async function submitMatchingPayment({
  matcherAddress,
  projectWallet,
  amount,
  originalTxHash,
  matchId,
}) {
  const idempotencyKey = `${MATCHING_IDEMPOTENCY_NAMESPACE}:${originalTxHash}:${matchId}`;

  try {
    const existing = await pool.query(
      "SELECT response_body FROM idempotency_keys WHERE key = $1",
      [idempotencyKey],
    );
    const existingResponse = getStoredMatchingResponse(existing.rows[0]);
    if (existingResponse) return existingResponse;

    let transaction;

    const pending = getPendingMatchingTransaction(existing.rows[0]);
    if (pending) {
      transaction = recoverMatchingTransaction(pending);
      const recorded = await findSuccessfulMatchingTransaction(pending.txHash);
      if (recorded) {
        const response = { success: true, txHash: pending.txHash };
        await storeMatchingResponse(idempotencyKey, response);
        return response;
      }
    } else if (existing.rows[0]) {
      // A legacy processing row has no transaction that can be safely
      // recovered. Never create a new payment for an unknown reservation.
      return {
        success: false,
        reason: "Matching payment reservation has no recoverable transaction",
      };
    }

    const matcherSecret = process.env.MATCHER_SECRET_KEY;
    if (!matcherSecret) {
      console.warn(
        "MATCHER_SECRET_KEY not configured. Cannot submit matching payment.",
      );
      return { success: false, reason: "Matcher secret not configured" };
    }

    const keypair = Keypair.fromSecret(matcherSecret);
    if (!pending && !existing.rows[0]) {
      // Build and sign exactly once before reserving the idempotency key.
      // Losing a reservation race discards this candidate and recovers the
      // winner's persisted transaction instead.
      const matcherAccount = await getServer().loadAccount(matcherAddress);
      transaction = new TransactionBuilder(matcherAccount, {
        fee: "100",
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(
          Operation.payment({
            destination: projectWallet,
            asset: Asset.native(),
            amount: amount.toFixed(7),
          }),
        )
        .addMemo(
          Operation.memo({
            type: "text",
            value: `Match:${originalTxHash.slice(0, 20)}`,
          }),
        )
        .setTimeout(60)
        .build();
      transaction.sign(keypair);

      const pendingResponse = JSON.stringify({
        status: "processing",
        txHash: transaction.hash().toString("hex"),
        signedXDR: transaction.toXDR(),
        effectsRecorded: false,
      });
      const reservation = await pool.query(
        `INSERT INTO idempotency_keys
           (key, request_body_hash, response_status, response_body)
         VALUES ($1, '', 202, $2)
         ON CONFLICT (key) DO NOTHING
         RETURNING key`,
        [idempotencyKey, pendingResponse],
      );
      if (!reservation.rows[0]) {
        const raced = await pool.query(
          "SELECT response_body FROM idempotency_keys WHERE key = $1",
          [idempotencyKey],
        );
        const racedResponse = getStoredMatchingResponse(raced.rows[0]);
        if (racedResponse) return racedResponse;
        const racedPending = getPendingMatchingTransaction(raced.rows[0]);
        if (!racedPending) {
          return {
            success: false,
            reason: "Matching payment reservation has no recoverable transaction",
          };
        }
        transaction = recoverMatchingTransaction(racedPending);
        const recorded = await findSuccessfulMatchingTransaction(
          racedPending.txHash,
        );
        if (recorded) {
          const response = { success: true, txHash: racedPending.txHash };
          await storeMatchingResponse(idempotencyKey, response);
          return response;
        }
      }
    }

    const { submitWithFeeBump } = require("./stellar");
    const result = await submitWithFeeBump(transaction, keypair, {
      onRetry: () => metrics.matchRetry.inc(),
    });

    console.log(`Matching payment submitted: ${result.hash}`);

    const response = {
      success: true,
      txHash: result.hash,
    };
    await storeMatchingResponse(idempotencyKey, response);
    return response;
  } catch (error) {
    console.error("Error submitting matching payment:", error);
    return { success: false, error: error.message };
  }
}

async function findSuccessfulMatchingTransaction(txHash) {
  const { getTransaction } = require("./stellar");
  if (typeof getTransaction !== "function") return null;

  try {
    const result = await getTransaction(txHash);
    return result && result.successful ? result : null;
  } catch {
    // A missing or temporarily unavailable Horizon record is safe to handle
    // by resubmitting the exact signed transaction below.
    return null;
  }
}

async function storeMatchingResponse(idempotencyKey, response) {
  await pool.query(
    "UPDATE idempotency_keys SET response_body = $1, response_status = 200 WHERE key = $2",
    [JSON.stringify({ ...response, effectsRecorded: false }), idempotencyKey],
  );
}

function getStoredMatchingResponse(row) {
  const response = parseIdempotencyResponse(row);
  if (
    !response ||
    response.status === "processing" ||
    response.success !== true ||
    !response.txHash
  ) {
    return null;
  }

  return {
    success: true,
    txHash: response.txHash,
    ...(response.effectsRecorded === true ? { alreadyProcessed: true } : {}),
  };
}

function getPendingMatchingTransaction(row) {
  const response = parseIdempotencyResponse(row);
  if (!response || !response.txHash || !response.signedXDR) return null;
  return response;
}

function parseIdempotencyResponse(row) {
  if (!row || row.response_body === null || row.response_body === undefined) {
    return null;
  }

  if (typeof row.response_body === "object") return row.response_body;
  try {
    return JSON.parse(row.response_body);
  } catch {
    return null;
  }
}

function recoverMatchingTransaction(pending) {
  let transaction;
  try {
    transaction = TransactionBuilder.fromXDR(
      pending.signedXDR,
      NETWORK_PASSPHRASE,
    );
  } catch (error) {
    throw new Error(`Stored matching transaction cannot be decoded: ${error.message}`);
  }

  const transactionHash = transaction.hash().toString("hex");
  if (transactionHash !== pending.txHash) {
    throw new Error("Stored matching transaction hash does not match its XDR");
  }
  return transaction;
}

async function recordMatchingDonation({
  projectId,
  donorAddress,
  amount,
  message,
  txHash,
  matchId,
}) {
  await pool.query(
    `WITH inserted AS (
       INSERT INTO donations (
         id, project_id, donor_address, amount_xlm, amount, currency,
         message, transaction_hash, created_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
       ON CONFLICT DO NOTHING
       RETURNING id
     )
     UPDATE donation_matches
     SET matched_xlm = matched_xlm + $4
     WHERE id = $9 AND EXISTS (SELECT 1 FROM inserted)`,
    [
      require("uuid").v4(),
      projectId,
      donorAddress,
      amount,
      amount,
      "XLM",
      message,
      txHash,
      matchId,
    ],
  );
}

async function markMatchingEffectsRecorded(originalTxHash, matchId, txHash) {
  const idempotencyKey = `${MATCHING_IDEMPOTENCY_NAMESPACE}:${originalTxHash}:${matchId}`;
  await pool.query(
    "UPDATE idempotency_keys SET response_body = $1 WHERE key = $2 AND response_status = 200",
    [
      JSON.stringify({
        success: true,
        txHash,
        effectsRecorded: true,
      }),
      idempotencyKey,
    ],
  );
}

/**
 * Submit a matching payment transaction for a matcher account.
 *
 * @param {{matcherAddress:string,projectWallet:string,amount:number,originalTxHash:string,matchId:string,projectId:string}} opts
 * @returns {Promise<{success:boolean,txHash?:string,reason?:string,error?:string}>}
 */
// exported as `submitMatchingPayment`

/**
 * Generate pre-signed transactions for a matcher up to a cap
 * This allows the Turret to submit transactions without needing the secret key at runtime
 */
async function generatePreSignedTransactions({
  matcherAddress,
  matcherSecret,
  projectWallet,
  capXlm,
  multiplier,
}) {
  const transactions = [];
  const matcherKeypair = require("@stellar/stellar-sdk").Keypair.fromSecret(
    matcherSecret,
  );

  // Generate transactions for different donation amounts
  const donationAmounts = [10, 25, 50, 100, 250];

  for (const donationAmount of donationAmounts) {
    const matchAmount = Math.min(donationAmount * multiplier, capXlm);

    if (matchAmount <= 0) continue;

    try {
      const account = await getServer().loadAccount(matcherAddress);

      const tx = new TransactionBuilder(account, {
        fee: "100",
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(
          Operation.payment({
            destination: projectWallet,
            asset: Asset.native(),
            amount: matchAmount.toFixed(7),
          }),
        )
        .setTimeout(60)
        .build();

      tx.sign(matcherKeypair);

      transactions.push({
        donationAmount,
        matchAmount,
        xdr: tx.toXDR(),
      });
    } catch (error) {
      console.error(
        `Error generating transaction for ${donationAmount} XLM:`,
        error,
      );
    }
  }

  return transactions;
}

/**
 * Generate a set of pre-signed matching transactions for a matcher account.
 *
 * @param {{matcherAddress:string,matcherSecret:string,projectWallet:string,capXlm:number,multiplier:number}} opts
 * @returns {Promise<Array<{donationAmount:number,matchAmount:number,xdr:string}>>}
 */
// exported as `generatePreSignedTransactions`

/**
 * Start the Turrets server
 * This creates an HTTP server that Turrets can call
 */
function startTurretsServer(port = 3001) {
  const express = require("express");
  const { adminKeyRequired } = require("../middleware/auth");
  const app = express();

  app.use(express.json());
  app.use(require("cors")());

  // Health check endpoint
  app.get("/health", (req, res) => {
    res.json({ status: "ok", service: "turrets-matching" });
  });

  // txFunction endpoint for matching donations
  app.post("/txfunction/matchDonation", async (req, res) => {
    try {
      const result = await matchDonationTxFunction(req.body);
      res.json(result);
    } catch (error) {
      console.error("Error in txFunction:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Endpoint to generate pre-signed transactions
  app.post("/admin/presign", adminKeyRequired, async (req, res) => {
    try {
      const {
        matcherAddress,
        matcherSecret,
        projectWallet,
        capXlm,
        multiplier,
        projectId,
      } = req.body;

      if (!matcherAddress || !matcherSecret || !projectWallet) {
        return res.status(400).json({ error: "Missing required parameters" });
      }

      const transactions = await generatePreSignedTransactions({
        matcherAddress,
        matcherSecret,
        projectWallet,
        capXlm: parseFloat(capXlm),
        multiplier: parseFloat(multiplier),
      });

      res.json({ success: true, transactions });
    } catch (error) {
      console.error("Error generating pre-signed transactions:", error);
      res.status(500).json({ error: error.message });
    }
  });

  return app.listen(port);
}

/**
 * Start a lightweight Turrets-compatible HTTP server exposing matching endpoints.
 *
 * @param {number} [port=3001] - TCP port to listen on.
 * @returns {import("http").Server} HTTP server instance.
 */
// exported as `startTurretsServer`

module.exports = {
  matchDonationTxFunction,
  submitMatchingPayment,
  generatePreSignedTransactions,
  startTurretsServer,
};
