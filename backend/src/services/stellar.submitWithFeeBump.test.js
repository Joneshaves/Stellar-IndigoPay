"use strict";

const mockPoll = jest.fn();
const mockHorizonServer = {
  submitTransaction: jest.fn(),
  transactions: jest.fn(() => ({
    transaction: jest.fn(() => ({ call: mockPoll })),
  })),
};
const mockRpcServer = {};
const mockTransactionBuilder = jest.fn();
mockTransactionBuilder.buildFeeBumpTransaction = jest.fn();

jest.mock("@stellar/stellar-sdk", () => ({
  Horizon: {
    Server: jest.fn().mockImplementation(() => mockHorizonServer),
    Account: jest.fn(),
  },
  Networks: { TESTNET: "testnet", PUBLIC: "public" },
  rpc: { Server: jest.fn().mockImplementation(() => mockRpcServer) },
  Contract: jest.fn(),
  TransactionBuilder: mockTransactionBuilder,
  scValToNative: jest.fn(),
  xdr: {},
}));

jest.mock("../logger", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

jest.mock("./tracing", () => ({
  withSpan: jest.fn((name, fn) => fn()),
}));

const { submitWithFeeBump } = require("./stellar");

describe("submitWithFeeBump Horizon retry", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockHorizonServer.submitTransaction
      .mockRejectedValueOnce(new Error("ETIMEDOUT"))
      .mockResolvedValueOnce({ hash: "tx-hash" });
    mockPoll.mockResolvedValueOnce({ successful: true });
  });

  test("retries the same signed transaction before fee bumping", async () => {
    const transaction = {
      operations: [{ type: "payment" }],
      fee: "100",
      toXDR: jest.fn().mockReturnValue("signed-xdr"),
      hash: jest.fn().mockReturnValue({
        toString: jest.fn().mockReturnValue("tx-hash"),
      }),
    };
    const keypair = { publicKey: jest.fn().mockReturnValue("GMATCHER") };
    const onRetry = jest.fn();

    await expect(
      submitWithFeeBump(transaction, keypair, { onRetry }),
    ).resolves.toEqual({ successful: true });

    expect(mockHorizonServer.submitTransaction).toHaveBeenCalledTimes(2);
    expect(mockHorizonServer.submitTransaction).toHaveBeenNthCalledWith(
      1,
      transaction,
    );
    expect(mockHorizonServer.submitTransaction).toHaveBeenNthCalledWith(
      2,
      transaction,
    );
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(mockTransactionBuilder.buildFeeBumpTransaction).not.toHaveBeenCalled();
  });
});
