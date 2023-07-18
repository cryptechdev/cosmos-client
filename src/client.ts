import { CosmWasmClient, MsgExecuteContractEncodeObject, SigningCosmWasmClient } from "@cosmjs/cosmwasm-stargate";
import { HdPath, Slip10RawIndex } from "@cosmjs/crypto";
import { DirectSecp256k1HdWallet, EncodeObject, OfflineDirectSigner } from "@cosmjs/proto-signing";
import { DeliverTxResponse, Event, GasPrice, SignerData, StdFee, isDeliverTxFailure } from "@cosmjs/stargate";
import { Tendermint37Client } from "@cosmjs/tendermint-rpc";
import { Network, NetworkEndpoints, getNetworkEndpoints } from "@injectivelabs/networks";
import {
  BaseAccount,
  ChainRestAuthApi,
  ChainRestTendermintApi,
  CreateTransactionResult,
  InjectiveDirectEthSecp256k1Wallet,
  MsgExecuteContract as InjectiveMsgExecuteContract,
  MsgSend as InjectiveMsgSend,
  MsgBroadcasterWithPk,
  Msgs,
  PrivateKey,
  PublicKey,
  TxGrpcApi,
  TxRestClient,
  createSignDocFromTransaction,
  createTransaction,
  createTxRawFromSigResponse,
  getGasPriceBasedOnMessage,
} from "@injectivelabs/sdk-ts";
import { BigNumberInBase, DEFAULT_BLOCK_TIMEOUT_HEIGHT, getStdFee } from "@injectivelabs/utils";
import { chains } from "chain-registry";
import { TxRaw } from "cosmjs-types/cosmos/tx/v1beta1/tx";
import { MsgExecuteContract } from "cosmjs-types/cosmwasm/wasm/v1/tx";
import { isCosmjsClient, isInjectiveClient } from "./utils";
import Decimal from "decimal.js";
import Long from "long";

export interface MsgBroadcasterTxOptions {
  msgs: Msgs | Msgs[];
  injectiveAddress: string;
  ethereumAddress?: string;
  memo?: string;
  gas?: {
    gasPrice?: string;
    gas?: number /** gas limit */;
    feePayer?: string;
    granter?: string;
  };
}

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
  endpoints: NetworkEndpoints;
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
    this.endpoints = options.endpoints;
    this.granter = options.granter;
    this.signer = options.signer;
    this.browserWallet = this.signer ? options.browserWallet : "keplr";
  }
  chainId: string;
  mnemonic: string;
  walletPrefix: string;
  rpcEndpoint: string;
  endpoints: NetworkEndpoints;
  coinType: number;
  gasDenom: string;
  gasPrice: number;
  gasAdjustment: number;
  walletType: "cosmos" | "injective";
  signingClient?: SigningCosmWasmClient | MsgBroadcasterWithPk;
  querier?: CosmWasmClient;
  cosmosAddress?: string;
  granter?: string;
  signer?: OfflineDirectSigner;
  browserWallet?: string;
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
      options.gasAdjustment = 1.1;
    }
    return options as CosmosClientOptions;
  }
  public static async new(opts: Partial<CosmosClientOptions>): Promise<CosmosClient> {
    const options = CosmosClient.sanitizeOptions(opts);

    const client = new CosmosClient(options as CosmosClientOptions);
    const signer = await client.getSigner();
    const gasPrice = GasPrice.fromString(`${client.gasPrice}${client.gasDenom}`);
    const tmClient = await Tendermint37Client.connect(client.rpcEndpoint);
    client.querier = await CosmWasmClient.create(tmClient);
    if (client.walletType === "cosmos" || client.signer) {
      client.cosmosAddress = (await signer.getAccounts())[0].address;
      client.signingClient = await SigningCosmWasmClient.createWithSigner(tmClient, signer, {
        gasPrice,
      });
    } else if (client.walletType === "injective") {
      const network: Network = Network[client.rpcEndpoint.indexOf("testnet") > -1 ? "TestnetK8s" : "MainnetK8s"];
      client.endpoints = getNetworkEndpoints(network);
      const privateKey = client.getPrivateKey();
      client.cosmosAddress = privateKey.toAddress().toBech32(client.walletPrefix);
      client.signingClient = new MsgBroadcasterWithPk({
        privateKey,
        network,
        endpoints: client.endpoints,
        simulateTx: true,
      });
    } else {
      throw new Error("Unsupported wallet type [cosmos, injective]");
    }
    return client;
  }
  async query(contractAddr: string, params: any): Promise<any> {
    if (!this.querier) {
      throw new Error("Client not initialized");
    }

    const payload = typeof params === "string" ? JSON.parse(params) : params;
    return await this.querier.queryContractSmart(contractAddr, payload);
  }

  private transformMsgs(msgs: readonly EncodeObject[]): Msgs[] {
    return msgs.map((msg: EncodeObject) => {
      if (msg.typeUrl.indexOf("MsgExecuteContract") > -1) {
        return InjectiveMsgExecuteContract.fromJSON({
          sender: this.cosmosAddress!,
          contractAddress: msg.value.contract!,
          msg:
            msg.value.msg instanceof Uint8Array
              ? JSON.parse(Buffer.from(msg.value.msg).toString("utf-8"))
              : msg.value.msg,
          funds: msg.value.funds,
        });
      } else if (msg.typeUrl.indexOf("MsgSend") > -1) {
        return InjectiveMsgSend.fromJSON({
          srcInjectiveAddress: this.cosmosAddress!,
          dstInjectiveAddress: msg.value.toAddress,
          amount: msg.value.amount,
        });
      } else throw new Error("Unsupported message type");
    });
  }

  private async prepareTxRaw(
    messages: readonly EncodeObject[],
    memo: string = "",
    fee?: StdFee,
    explicitSignerData?: SignerData,
  ): Promise<[CreateTransactionResult, { accountNumber: number; sequence: number }]> {
    if (isInjectiveClient(this.signingClient)) {
      const injMessages = this.transformMsgs(messages);
      const tx = {
        msgs: injMessages,
        injectiveAddress: this.cosmosAddress!,
        memo,
        gas: fee as any,
      } as MsgBroadcasterTxOptions;
      const publicKey = this.signer
        ? // @ts-ignore
          PublicKey.fromBytes(window[this.browserWallet].getKey(this.chainId))
        : this.signingClient.privateKey.toPublicKey();
      const account = explicitSignerData ? { ...explicitSignerData } : await this.getAccount();
      if (!account) {
        throw new Error("Account not found");
      }
      const chainRestTendermintApi = new ChainRestTendermintApi(this.endpoints.rest);
      const latestBlock = await chainRestTendermintApi.fetchLatestBlock();
      const latestHeight = latestBlock.header.height;
      const timeoutHeight = new BigNumberInBase(latestHeight).plus(DEFAULT_BLOCK_TIMEOUT_HEIGHT);
      const gas = (tx.gas?.gas || getGasPriceBasedOnMessage(injMessages)).toString();
      return [
        createTransaction({
          memo: tx.memo || "",
          message: injMessages,
          fee: getStdFee({ ...tx.gas, gas }),
          timeoutHeight: timeoutHeight.toNumber(),
          pubKey: publicKey.toBase64(),
          sequence: account.sequence,
          accountNumber: account.accountNumber,
          chainId: this.chainId,
        }),
        account,
      ];
    }
    throw new Error("Unsupported signing client");
  }

  async sign(
    signerAddress: string,
    messages: readonly EncodeObject[],
    fee: StdFee,
    memo: string,
    explicitSignerData?: SignerData,
  ): Promise<TxRaw> {
    if (isCosmjsClient(this.signingClient)) {
      return this.signingClient!.sign(signerAddress, messages, fee, memo, explicitSignerData);
    } else if (isInjectiveClient(this.signingClient)) {
      const [{ signBytes, txRaw }, account] = await this.prepareTxRaw(messages, memo, fee, explicitSignerData);

      if (this.signer) {
        const signDoc = createSignDocFromTransaction({
          txRaw,
          accountNumber: account.accountNumber,
          chainId: this.chainId,
        });

        const directSignResponse = await this.signer.signDirect(this.cosmosAddress!, {
          ...signDoc,
          accountNumber: Long.fromString(signDoc.accountNumber),
        });
        return createTxRawFromSigResponse(directSignResponse);
      } else {
        const signature = await this.signingClient.privateKey.sign(Buffer.from(signBytes));
        txRaw.signatures = [signature];
        return txRaw;
      }
    } else {
      throw new Error("Client not supported for signing");
    }
  }

  async broadcast(txRaw: TxRaw): Promise<DeliverTxResponse> {
    if (isCosmjsClient(this.signingClient)) {
      const bytes = TxRaw.encode(txRaw).finish();
      return await this.signingClient.broadcastTx(bytes);
    } else if (isInjectiveClient(this.signingClient)) {
      const txResponse = await new TxGrpcApi(this.endpoints.grpc).broadcast(txRaw);

      if (txResponse.code !== 0) {
        throw new Error(`Transaction failed to be broadcasted - ${txResponse.rawLog}`);
      }
      return {
        ...txResponse,
        transactionHash: txResponse.txHash,
        txIndex: 0,
        events: (txResponse.events as readonly Event[]) || [],
        data: [],
      };
    }
    throw new Error("Client not supported for broadcasting");
  }

  async signAndBroadcast(msgs: EncodeObject[], memo?: string, fee?: StdFee): Promise<DeliverTxResponse> {
    if (isCosmjsClient(this.signingClient)) {
      return this.signingClient!.signAndBroadcast(this.cosmosAddress!, msgs, fee || "auto", memo);
    } else if (isInjectiveClient(this.signingClient)) {
      const estimatedGas = new Decimal((await this.simulateFees(msgs)).gas).mul(this.gasAdjustment);
      const estimatedFees = estimatedGas.mul(this.gasPrice);
      const fees: StdFee = {
        amount: [
          {
            amount: estimatedFees.toFixed(0),
            denom: this.gasDenom,
          },
        ],
        gas: estimatedGas.toFixed(0),
        granter: this.granter,
      };

      const account = await this.getAccount();
      if (!account) {
        throw new Error("Account not found");
      }
      const { sequence, accountNumber } = account;

      const signedTx: TxRaw = await this.sign(this.cosmosAddress!, msgs, fees, "empty wallet", {
        accountNumber,
        sequence: sequence + 1,
        chainId: this.chainId,
      });
      return await this.broadcast(signedTx);
    }
    throw new Error("Client not supported for signing and broadcasting");
  }

  async getAccount(): Promise<{ accountNumber: number; sequence: number } | null> {
    if (isCosmjsClient(this.signingClient)) {
      return await this.signingClient.getAccount(this.cosmosAddress!);
    } else if (isInjectiveClient(this.signingClient)) {
      const chainRestAuthApi = new ChainRestAuthApi(this.endpoints.rest);
      const accountDetailsResponse = await chainRestAuthApi.fetchAccount(this.cosmosAddress!);
      const baseAccount = BaseAccount.fromRestApi(accountDetailsResponse);
      const accountDetails = baseAccount.toAccountDetails();
      return accountDetails;
    }
    return null;
  }

  async tx(contract: string, payload: any): Promise<string> {
    let response: any;
    if (isCosmjsClient(this.signingClient)) {
      const msgs: MsgExecuteContractEncodeObject[] = [
        {
          typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
          value: MsgExecuteContract.fromPartial({
            sender: this.cosmosAddress!,
            contract,
            msg: Buffer.from(JSON.stringify(typeof payload === "string" ? JSON.parse(payload) : payload)),
          }),
        },
      ];
      const fees = await this.simulateFees(msgs);
      response = await this.signingClient.signAndBroadcast(this.cosmosAddress!, msgs, fees);
    } else if (isInjectiveClient(this.signingClient)) {
      const msgs: InjectiveMsgExecuteContract[] = [
        InjectiveMsgExecuteContract.fromJSON({
          sender: this.cosmosAddress!,
          contractAddress: contract,
          msg: typeof payload === "string" ? JSON.parse(payload) : payload,
        }),
      ];
      const injResponse = await this.signingClient
        .broadcast({
          msgs,
          injectiveAddress: this.cosmosAddress!,
          gas: {
            granter: this.granter,
          },
        })
        .catch((e: any) => {
          if (typeof e === "object" && "originalMessage" in e) {
            throw new Error(e.originalMessage);
          }
          throw e;
        });

      response = { ...injResponse, transactionHash: injResponse.txHash };
    }
    if (isDeliverTxFailure(response)) {
      throw new Error(`Tx failed: ${response.rawLog}`);
    }

    return response.transactionHash;
  }
  async simulateFees(msgs: EncodeObject[]): Promise<StdFee> {
    if (isCosmjsClient(this.signingClient)) {
      const gas = await this.signingClient.simulate(this.cosmosAddress!, msgs as EncodeObject[], undefined);
      return {
        amount: [
          {
            denom: this.gasDenom,
            amount: Math.ceil(gas * this.gasPrice! * this.gasAdjustment!).toString(),
          },
        ],
        gas: Math.ceil(gas * this.gasAdjustment!).toString(),
        granter: this.granter,
      } as StdFee;
    } else if (isInjectiveClient(this.signingClient)) {
      const txClient = new TxRestClient(this.endpoints.rest);
      const [{ txRaw }] = await this.prepareTxRaw(msgs);
      const fees = await txClient.simulate(txRaw);
      return {
        amount: [
          {
            denom: this.gasDenom,
            amount: Math.ceil(fees.gasInfo.gasUsed * this.gasPrice! * this.gasAdjustment!).toString(),
          },
        ],
        gas: Math.ceil(fees.gasInfo.gasUsed * this.gasAdjustment!).toString(),
        granter: this.granter,
      } as StdFee;
    } else {
      throw new Error("Invalid signing client to simulate fees");
    }
  }
}
