"use strict";

const mockPoolQuery = jest.fn();
const mockHorizonServer = { loadAccount: jest.fn() };
const mockSubmitWithFeeBump = jest.fn();
const mockGetTransaction = jest.fn();
const mockMemoText = jest.fn();
const mockTransaction = {
  sign: jest.fn(),
  hash: jest.fn().mockReturnValue({ toString: jest.fn().mockReturnValue("tx-hash") }),
  toXDR: jest.fn().mockReturnValue("signed-xdr"),
};
const mockTransactionBuilder = jest.fn().mockImplementation(() => ({
  addOperation: jest.fn().mockReturnThis(),
  addMemo: jest.fn().mockReturnThis(),
  setTimeout: jest.fn().mockReturnThis(),
  build: jest.fn().mockReturnValue(mockTransaction),
}));
mockTransactionBuilder.fromXDR = jest.fn().mockReturnValue(mockTransaction);
const mockKeypair = { publicKey: jest.fn().mockReturnValue("GMATCHER") };
const mockMatchRetry = { inc: jest.fn() };

jest.mock("../db/pool", () => ({ query: mockPoolQuery }));

jest.mock("../logger", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

jest.mock("./metrics", () => ({
  metrics: { matchRetry: mockMatchRetry },
}));

jest.mock("./stellar", () => ({
  submitWithFeeBump: mockSubmitWithFeeBump,
  getTransaction: mockGetTransaction,
}));

jest.mock("@stellar/stellar-sdk", () => ({
  Server: jest.fn().mockImplementation(() => mockHorizonServer),
  TransactionBuilder: mockTransactionBuilder,
  Networks: { TESTNET: "testnet", PUBLIC: "public" },
  Operation: {
    payment: jest.fn(),
  },
  Memo: { text: mockMemoText },
  Asset: { native: jest.fn() },
  Keypair: { fromSecret: jest.fn().mockReturnValue(mockKeypair) },
}));

const { matchDonationTxFunction, submitMatchingPayment } = require("./turrets");

const options = {
  matcherAddress: "GMATCHER",
  projectWallet: "GPROJECT",
  amount: 2.5,
  originalTxHash: "original-transaction-hash",
  matchId: "match-7",
};

describe("submitMatchingPayment", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.MATCHER_SECRET_KEY = "SMATCHERSECRET";
    mockHorizonServer.loadAccount.mockResolvedValue({});
    mockSubmitWithFeeBump.mockResolvedValue({ hash: "tx-hash" });
    mockGetTransaction.mockRejectedValue(new Error("404 Not Found"));
    mockTransactionBuilder.fromXDR.mockReturnValue(mockTransaction);
  });

  afterEach(() => {
    delete process.env.MATCHER_SECRET_KEY;
  });

  test("retries a transient Horizon failure without rebuilding or double-paying", async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ key: "reserved" }] })
      .mockResolvedValueOnce({ rows: [] });
    mockSubmitWithFeeBump.mockImplementationOnce(async (transaction, keypair, options) => {
      options.onRetry({ attempt: 1, error: new Error("ETIMEDOUT") });
      return { hash: "tx-hash" };
    });

    await expect(submitMatchingPayment(options)).resolves.toEqual({
      success: true,
      txHash: "tx-hash",
    });

    expect(mockTransactionBuilder).toHaveBeenCalledTimes(1);
    expect(mockTransaction.sign).toHaveBeenCalledTimes(1);
    expect(mockMemoText).toHaveBeenCalledWith(
      `Match:${options.originalTxHash.slice(0, 20)}`,
    );
    expect(mockSubmitWithFeeBump).toHaveBeenCalledTimes(1);
    expect(mockSubmitWithFeeBump.mock.calls[0][2]).toEqual({
      onRetry: expect.any(Function),
    });
    expect(mockMatchRetry.inc).toHaveBeenCalledTimes(1);
    expect(mockPoolQuery.mock.calls[1][0]).toContain("ON CONFLICT (key) DO NOTHING");
    expect(JSON.parse(mockPoolQuery.mock.calls[1][1][1])).toMatchObject({
      status: "processing",
      txHash: "tx-hash",
      signedXDR: "signed-xdr",
      effectsRecorded: false,
    });
  });

  test("returns the recorded result without submitting again", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ response_body: {
        success: true,
        txHash: "stored-hash",
        effectsRecorded: true,
      } }],
    });

    await expect(submitMatchingPayment(options)).resolves.toEqual({
      success: true,
      txHash: "stored-hash",
      alreadyProcessed: true,
    });

    expect(mockPoolQuery).toHaveBeenCalledTimes(1);
    expect(mockHorizonServer.loadAccount).not.toHaveBeenCalled();
    expect(mockSubmitWithFeeBump).not.toHaveBeenCalled();
    expect(mockMatchRetry.inc).not.toHaveBeenCalled();
  });

  test("returns the stored result on a repeated call", async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ key: "reserved" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ response_body: { success: true, txHash: "tx-hash" } }],
      });

    await expect(submitMatchingPayment(options)).resolves.toEqual({
      success: true,
      txHash: "tx-hash",
    });
    await expect(submitMatchingPayment(options)).resolves.toEqual({
      success: true,
      txHash: "tx-hash",
    });

    expect(mockSubmitWithFeeBump).toHaveBeenCalledTimes(1);
    expect(mockTransactionBuilder).toHaveBeenCalledTimes(1);
  });

  test("recovers the exact pending transaction when another caller owns the reservation", async () => {
    mockPoolQuery
      .mockResolvedValueOnce({
        rows: [{
          response_body: {
            status: "processing",
            txHash: "tx-hash",
            signedXDR: "signed-xdr",
          },
        }],
      });

    await expect(submitMatchingPayment(options)).resolves.toEqual({
      success: true,
      txHash: "tx-hash",
    });

    expect(mockTransactionBuilder).not.toHaveBeenCalled();
    expect(mockTransactionBuilder.fromXDR).toHaveBeenCalledWith(
      "signed-xdr",
      expect.any(String),
    );
    expect(mockSubmitWithFeeBump).toHaveBeenCalledTimes(1);
  });

  test("records a pending transaction already included by Horizon without resubmitting", async () => {
    mockPoolQuery
      .mockResolvedValueOnce({
        rows: [{
          response_body: {
            status: "processing",
            txHash: "tx-hash",
            signedXDR: "signed-xdr",
          },
        }],
      })
      .mockResolvedValueOnce({ rows: [] });
    mockGetTransaction.mockResolvedValueOnce({
      successful: true,
      hash: "tx-hash",
    });

    await expect(submitMatchingPayment(options)).resolves.toEqual({
      success: true,
      txHash: "tx-hash",
    });

    expect(mockSubmitWithFeeBump).not.toHaveBeenCalled();
    expect(mockTransactionBuilder.fromXDR).toHaveBeenCalledTimes(1);
  });

  test("losing the reservation race recovers the winner transaction", async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          response_body: {
            status: "processing",
            txHash: "tx-hash",
            signedXDR: "signed-xdr",
          },
        }],
      })
      .mockResolvedValueOnce({ rows: [] });

    await expect(submitMatchingPayment(options)).resolves.toEqual({
      success: true,
      txHash: "tx-hash",
    });

    expect(mockTransactionBuilder).toHaveBeenCalledTimes(1);
    expect(mockTransactionBuilder.fromXDR).toHaveBeenCalledTimes(1);
    expect(mockSubmitWithFeeBump).toHaveBeenCalledTimes(1);
  });

  test("a successful replay skips matching database side effects", async () => {
    mockPoolQuery
      .mockResolvedValueOnce({
        rows: [{ id: "project-1", name: "Project" }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: "match-7",
          matcher_address: "GMATCHER",
          cap_xlm: "10",
          matched_xlm: "0",
          multiplier: 1,
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          response_body: {
            success: true,
            txHash: "stored-hash",
            effectsRecorded: true,
          },
        }],
      });

    await expect(matchDonationTxFunction({
      asset_type: "native",
      transaction_hash: "original-transaction-hash",
      from: "GDONOR",
      to: "GPROJECT",
      amount: "2.5",
    })).resolves.toMatchObject({
      matched: true,
      totalMatched: 2.5,
      matches: [{ txHash: "stored-hash" }],
    });

    expect(mockSubmitWithFeeBump).not.toHaveBeenCalled();
    expect(mockPoolQuery).toHaveBeenCalledTimes(3);
    expect(mockPoolQuery.mock.calls.some(([sql]) => /UPDATE donation_matches|INSERT INTO donations/.test(sql))).toBe(false);
  });

  test("a first match records effects once and a replay does not repeat them", async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ id: "project-1", name: "Project" }] })
      .mockResolvedValueOnce({
        rows: [{
          id: "match-7",
          matcher_address: "GMATCHER",
          cap_xlm: "10",
          matched_xlm: "0",
          multiplier: 1,
        }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ key: "reserved" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "project-1", name: "Project" }] })
      .mockResolvedValueOnce({
        rows: [{
          id: "match-7",
          matcher_address: "GMATCHER",
          cap_xlm: "10",
          matched_xlm: "0",
          multiplier: 1,
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          response_body: {
            success: true,
            txHash: "tx-hash",
            effectsRecorded: true,
          },
        }],
      });

    const payment = {
      asset_type: "native",
      transaction_hash: "original-transaction-hash",
      from: "GDONOR",
      to: "GPROJECT",
      amount: "2.5",
    };
    await matchDonationTxFunction(payment);
    await matchDonationTxFunction(payment);

    expect(mockSubmitWithFeeBump).toHaveBeenCalledTimes(1);
    expect(mockPoolQuery.mock.calls.filter(([sql]) => sql.includes("WITH inserted AS")).length).toBe(1);
    const effectMarkers = mockPoolQuery.mock.calls.filter(([sql, params]) =>
      sql.includes("UPDATE idempotency_keys") &&
      JSON.parse(params[0]).effectsRecorded === true,
    );
    expect(effectMarkers).toHaveLength(1);
  });
});
