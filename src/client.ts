import { encodeSecp256k1Pubkey } from "@cosmjs/amino";
import { CosmWasmClient, SigningCosmWasmClient } from "@cosmjs/cosmwasm-stargate";
import { HdPath, Slip10RawIndex } from "@cosmjs/crypto";
import { fromBase64 } from "@cosmjs/encoding";
import {
  DirectSecp256k1HdWallet,
  EncodeObject,
  OfflineDirectSigner,
  makeAuthInfoBytes,
  makeSignDoc,
} from "@cosmjs/proto-signing";
import {
  DeliverTxResponse,
  GasPrice,
  QueryClient,
  SignerData,
  StdFee,
  createProtobufRpcClient,
  isDeliverTxFailure,
} from "@cosmjs/stargate";
import { Tendermint37Client } from "@cosmjs/tendermint-rpc";
import { InjectiveTypesV1Beta1Account } from "@injectivelabs/core-proto-ts";
import {
  InjectiveDirectEthSecp256k1Wallet,
  PrivateKey
} from "@injectivelabs/sdk-ts";
import { chains } from "chain-registry";
import { QueryAccountRequest, QueryClientImpl } from "cosmjs-types/cosmos/auth/v1beta1/query";
import { SignMode } from "cosmjs-types/cosmos/tx/signing/v1beta1/signing";
import { ServiceClientImpl, SimulateRequest } from "cosmjs-types/cosmos/tx/v1beta1/service";
import { AuthInfo, Fee, Tx, TxBody, TxRaw } from "cosmjs-types/cosmos/tx/v1beta1/tx";
import { MsgExecuteContract } from "cosmjs-types/cosmwasm/wasm/v1/tx";
import Decimal from "decimal.js";
import Long from "long";
import { encodePubkey } from "./utils";

export type CosmosClientOptions = {
  chainId: string;
  mnemonic: string;
  walletPrefix: string;
  rpcEndpoint: string;
  coinType: number | string;
  gasDenom: string;
  gasPrice: number | string;
  gasAdjustment: number | string;
  walletType: "cosmos" | "injective";
  granter?: string;
  signer?: OfflineDirectSigner;
  browserWallet?: string;
};

export class CosmosClient {
  private constructor(options: CosmosClientOptions) {
    this.chainId = options.chainId;
    this.mnemonic = options.mnemonic;
    this.walletPrefix = options.walletPrefix;
    this.rpcEndpoint = options.rpcEndpoint;
    this.coinType = Number(options.coinType);
    this.gasDenom = options.gasDenom;
    this.gasPrice = Number(options.gasPrice);
    this.gasAdjustment = Number(options.gasAdjustment);
    this.walletType = options.walletType;
    this.granter = options.granter;
    this.signer = options.signer;
    this.browserWallet = this.signer ? options.browserWallet : "keplr";
  }
  chainId: string;
  mnemonic: string;
  walletPrefix: string;
  rpcEndpoint: string;
  coinType: number;
  gasDenom: string;
  gasPrice: number;
  gasAdjustment: number;
  walletType: "cosmos" | "injective";
  signingClient?: SigningCosmWasmClient;
  querier?: CosmWasmClient;
  cosmosAddress?: string;
  granter?: string;
  signer?: OfflineDirectSigner;
  browserWallet?: string;
  tmClient?: Tendermint37Client;
  private getPrivateKey(): PrivateKey {
    return PrivateKey.fromMnemonic(this.mnemonic, `m/44'/${this.coinType}'/0'/0/0`);
  }
  private generateHdPath(coinType: string): HdPath {
    return [
      Slip10RawIndex.hardened(44),
      Slip10RawIndex.hardened(Number(coinType)),
      Slip10RawIndex.hardened(0),
      Slip10RawIndex.normal(0),
      Slip10RawIndex.normal(0),
    ];
  }
  private async getSigner(): Promise<OfflineDirectSigner> {
    if (this.signer) return this.signer;
    if (this.walletType === "injective") {
      const key = this.getPrivateKey();
      return (await InjectiveDirectEthSecp256k1Wallet.fromKey(
        Buffer.from(key.toPrivateKeyHex().slice(2), "hex"),
      )) as OfflineDirectSigner;
    } else {
      return await DirectSecp256k1HdWallet.fromMnemonic(this.mnemonic, {
        prefix: this.walletPrefix,
        hdPaths: [this.generateHdPath(`${this.coinType}`)],
      });
    }
  }

  private static sanitizeOptions(options: Partial<CosmosClientOptions>): CosmosClientOptions {
    if (!options.chainId || options.chainId.length === 0) {
      throw new Error(`Missing chainId`);
    }
    if ((!options.mnemonic || options.mnemonic.length === 0) && !options.signer) {
      throw new Error(`Missing mnemonic (or signer)`);
    }
    options.mnemonic = options.mnemonic || "";
    const selectedChainInfo = chains.find((c) => c.chain_id === options.chainId);
    if (selectedChainInfo !== undefined) {
      if (options.rpcEndpoint !== undefined && options.rpcEndpoint.length > 0) {
        options.rpcEndpoint = options.rpcEndpoint;
      } else if (selectedChainInfo.apis?.rpc && selectedChainInfo.apis.rpc.length > 0) {
        options.rpcEndpoint = selectedChainInfo.apis.rpc[0].address;
      } else {
        throw new Error("No rpcEndpoint provided");
      }

      if (options.walletPrefix !== undefined && options.walletPrefix.length > 0) {
        options.walletPrefix = options.walletPrefix;
      } else {
        options.walletPrefix = selectedChainInfo.bech32_prefix;
      }

      if (options.coinType !== undefined && `${options.coinType}`.length > 0 && !isNaN(Number(options.coinType))) {
        options.coinType = Number(options.coinType);
      } else {
        options.coinType = selectedChainInfo.slip44;
      }

      if (options.gasDenom !== undefined && options.gasDenom.length > 0) {
        options.gasDenom = options.gasDenom;
      } else if (selectedChainInfo.fees && selectedChainInfo.fees.fee_tokens.length > 0) {
        options.gasDenom = selectedChainInfo.fees.fee_tokens[0].denom;
      } else {
        throw new Error("No gasDenom provided");
      }

      if (options.gasPrice !== undefined && `${options.gasPrice}`.length > 0 && !isNaN(Number(options.gasPrice))) {
        options.gasPrice = Number(options.gasPrice);
      } else if (selectedChainInfo.fees && selectedChainInfo.fees.fee_tokens.length > 0) {
        options.gasPrice =
          selectedChainInfo.fees.fee_tokens[0].fixed_min_gas_price ||
          selectedChainInfo.fees.fee_tokens[0].average_gas_price ||
          0;
      } else {
        throw new Error("No gasPrice provided");
      }

      options.walletType = selectedChainInfo.chain_name.indexOf("injective") > -1 ? "injective" : "cosmos";
    } else {
      if (options.rpcEndpoint === undefined || options.rpcEndpoint.length === 0) {
        throw new Error("No rpcEndpoint provided");
      }
      options.rpcEndpoint = options.rpcEndpoint;

      if (options.walletPrefix === undefined || options.walletPrefix.length === 0) {
        throw new Error("No walletPrefix provided");
      }
      options.walletPrefix = options.walletPrefix;

      if (options.gasDenom === undefined || options.gasDenom.length === 0) {
        throw new Error("No gasDenom provided");
      }
      options.gasDenom = options.gasDenom;

      if (options.gasPrice === undefined || `${options.gasPrice}`.length === 0 || isNaN(Number(options.gasPrice))) {
        throw new Error("No gasPrice provided");
      }
      options.gasPrice = Number(options.gasPrice);

      if (options.coinType !== undefined && `${options.coinType}`.length > 0 && !isNaN(Number(options.coinType))) {
        options.coinType = Number(options.coinType);
      } else {
        options.coinType = 118;
      }
    }

    options.granter = options.granter;

    if (
      options.gasAdjustment !== undefined &&
      `${options.gasAdjustment}`.length > 0 &&
      !isNaN(Number(options.gasAdjustment))
    ) {
      options.gasAdjustment = Number(options.gasAdjustment);
    } else {
      options.gasAdjustment = 1.3;
    }
    return options as CosmosClientOptions;
  }
  public static async new(opts: Partial<CosmosClientOptions>): Promise<CosmosClient> {
    const options = CosmosClient.sanitizeOptions(opts);

    const client = new CosmosClient(options as CosmosClientOptions);
    const signer = await client.getSigner();
    const gasPrice = GasPrice.fromString(`${client.gasPrice}${client.gasDenom}`);
    client.tmClient = await Tendermint37Client.connect(client.rpcEndpoint);
    client.querier = await CosmWasmClient.create(client.tmClient);
    client.cosmosAddress = (await signer.getAccounts())[0].address;
    client.signingClient = await SigningCosmWasmClient.createWithSigner(client.tmClient, signer, {
      gasPrice,
    });
    return client;
  }
  async query(contractAddr: string, params: any): Promise<any> {
    if (!this.querier) {
      throw new Error("Client not initialized");
    }

    const payload = typeof params === "string" ? JSON.parse(params) : params;
    return await this.querier.queryContractSmart(contractAddr, payload);
  }

  async sign(messages: readonly EncodeObject[], memo: string, explicitSignerData?: SignerData): Promise<TxRaw> {
    const encodedMessages = messages.map((msg) => this.signingClient!.registry.encodeAsAny(msg));

    const { accountNumber, txBodyBytes, authInfoBytes } = await this.prepareTx(
      encodedMessages,
      memo,
      explicitSignerData,
    );
    const signDoc = makeSignDoc(txBodyBytes, authInfoBytes, this.chainId, accountNumber);
    const { signature, signed } = await (await this.getSigner()).signDirect(this.cosmosAddress!, signDoc);

    return TxRaw.fromPartial({
      bodyBytes: signed.bodyBytes,
      authInfoBytes: signed.authInfoBytes,
      signatures: [fromBase64(signature.signature)],
    });
  }

  async broadcast(txRaw: TxRaw): Promise<DeliverTxResponse> {
    const bytes = TxRaw.encode(txRaw).finish();
    return await (this.signingClient as SigningCosmWasmClient).broadcastTx(bytes);
  }

  async signAndBroadcast(msgs: EncodeObject[], memo?: string, fee?: StdFee): Promise<DeliverTxResponse> {
    const signedTx: TxRaw = await this.sign(msgs, memo || "");
    return await this.broadcast(signedTx);
  }

  async getAccount(): Promise<{ accountNumber: number; sequence: number } | null> {
    if (this.walletType === "cosmos") {
      const response = await (this.signingClient as SigningCosmWasmClient).getAccount(this.cosmosAddress!);
      if (!response || !response.pubkey) {
        return null;
      }
      return {
        accountNumber: response.accountNumber,
        sequence: response.sequence,
      };
    } else if (this.walletType === "injective") {
      const client = new QueryClient(this.tmClient!);
      const rpc = createProtobufRpcClient(client);
      const queryService = new QueryClientImpl(rpc);
      const response = await queryService.Account(QueryAccountRequest.fromPartial({ address: this.cosmosAddress! }));
      const decodedResponse = InjectiveTypesV1Beta1Account.EthAccount.decode(response.account!.value);

      return {
        accountNumber: Number(decodedResponse.baseAccount!.accountNumber),
        sequence: Number(decodedResponse.baseAccount!.sequence),
      };
    }
    return null;
  }

  private async prepareTx(
    msgs: EncodeObject[],
    memo?: string,
    explicitSignerData?: SignerData,
  ): Promise<{
    fees: StdFee;
    accountNumber: number;
    sequence: number;
    txBodyBytes: Uint8Array;
    authInfoBytes: Uint8Array;
  }> {
    const txBody = TxBody.fromPartial({
      messages: msgs,
      memo: memo || "",
    });

    const txBodyBytes = TxBody.encode(txBody).finish();
    const account = explicitSignerData
      ? {
          accountNumber: explicitSignerData.accountNumber,
          sequence: explicitSignerData.sequence,
        }
      : await this.getAccount();
    if (account === null) throw new Error("Account not found");

    const { sequence, accountNumber } = account;
    const accountFromSigner = (await (await this.getSigner()).getAccounts())![0];
    const pubkey = encodePubkey(encodeSecp256k1Pubkey(accountFromSigner.pubkey), this.walletType === "injective");

    const fees = await this.simulateFees(msgs);

    const authInfoBytes = makeAuthInfoBytes(
      [
        {
          pubkey,
          sequence,
        },
      ],
      fees.amount,
      new Decimal(fees.gas).toNumber(),
      fees.granter,
      fees.payer,
    );
    return {
      fees,
      accountNumber,
      sequence,
      txBodyBytes,
      authInfoBytes,
    };
  }

  async tx(contract: string, payload: any): Promise<string> {
    if (!this.signingClient || !this.cosmosAddress) {
      throw new Error("Signing client not initialized");
    }
    let response: any;
    const msgs: EncodeObject[] = [
      this.signingClient!.registry.encodeAsAny({
        typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
        value: MsgExecuteContract.fromPartial({
          sender: this.cosmosAddress!,
          contract,
          msg: Buffer.from(JSON.stringify(typeof payload === "string" ? JSON.parse(payload) : payload)),
        }),
      }),
    ];

    const { accountNumber, txBodyBytes, authInfoBytes } = await this.prepareTx(msgs);

    const signDoc = makeSignDoc(txBodyBytes, authInfoBytes, this.chainId, accountNumber);
    const { signature, signed } = await (await this.getSigner()).signDirect(this.cosmosAddress!, signDoc);
    const txRaw = TxRaw.fromPartial({
      bodyBytes: signed.bodyBytes,
      authInfoBytes: signed.authInfoBytes,
      signatures: [fromBase64(signature.signature)],
    });
    const txBytes = TxRaw.encode(txRaw).finish();
    response = await (this.signingClient as SigningCosmWasmClient).broadcastTx(txBytes);

    if (isDeliverTxFailure(response)) {
      throw new Error(`Tx failed: ${response.rawLog}`);
    }

    return response.transactionHash;
  }
  async simulateFees(msgs: EncodeObject[]): Promise<StdFee> {
    const client = new QueryClient(this.tmClient!);
    const rpc = createProtobufRpcClient(client);
    const queryService = new ServiceClientImpl(rpc);
    const account = await this.getAccount();
    if (account === null) throw new Error("Account not found");

    const { sequence } = account;
    const accountFromSigner = (await (await this.getSigner()).getAccounts())![0];
    const pubkey = encodePubkey(encodeSecp256k1Pubkey(accountFromSigner.pubkey), this.walletType === "injective");

    const tx = Tx.fromPartial({
      authInfo: AuthInfo.fromPartial({
        fee: Fee.fromPartial({}),
        signerInfos: [
          {
            publicKey: pubkey,
            sequence: Long.fromNumber(sequence, true),
            modeInfo: { single: { mode: SignMode.SIGN_MODE_UNSPECIFIED } },
          },
        ],
      }),
      body: TxBody.fromPartial({
        messages: Array.from(msgs),
        memo: "",
      }),
      signatures: [new Uint8Array()],
    });
    const request = SimulateRequest.fromPartial({
      txBytes: Tx.encode(tx).finish(),
    });
    const response = await queryService.Simulate(request);

    const gas = new Decimal(response.gasInfo!.gasUsed.toString());

    return {
      amount: [
        {
          denom: this.gasDenom,
          amount: gas.mul(new Decimal(this.gasAdjustment!)).round().mul(new Decimal(this.gasPrice!)).ceil().toFixed(0),
        },
      ],
      gas: gas.mul(new Decimal(this.gasAdjustment!)).round().toFixed(0),
      granter: this.granter,
    } as StdFee;
  }
}
