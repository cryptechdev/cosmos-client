import { HdPath, Slip10RawIndex } from "@cosmjs/crypto";
import { MsgExecuteContract } from "cosmjs-types/cosmwasm/wasm/v1/tx";
import { Network, getNetworkEndpoints } from "@injectivelabs/networks";
import { chains } from "chain-registry";
import { DirectSecp256k1HdWallet, EncodeObject, OfflineDirectSigner } from "@cosmjs/proto-signing";
import {
  InjectiveDirectEthSecp256k1Wallet,
  MsgExecuteContract as InjectiveMsgExecuteContract,
  MsgBroadcasterWithPk,
  PrivateKey,
} from "@injectivelabs/sdk-ts";
import { GasPrice, StdFee, isDeliverTxFailure } from "@cosmjs/stargate";
import { Tendermint37Client } from "@cosmjs/tendermint-rpc";
import { CosmWasmClient, SigningCosmWasmClient } from "@cosmjs/cosmwasm-stargate";
import { isCosmjsClient, isInjectiveClient } from "./utils";

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
  signingClient?: any;
  querier?: any;
  cosmosAddress?: string;
  granter?: string;
  private generateHdPath(coinType: string): HdPath {
    return [
      Slip10RawIndex.hardened(44),
      Slip10RawIndex.hardened(Number(coinType)),
      Slip10RawIndex.hardened(0),
      Slip10RawIndex.normal(0),
      Slip10RawIndex.normal(0),
    ];
  }
  private getPrivateKey(): PrivateKey {
    return PrivateKey.fromMnemonic(this.mnemonic, `m/44'/${this.coinType}'/0'/0/0`);
  }
  private async getSigner(): Promise<OfflineDirectSigner> {
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
  public static async new(options: Partial<CosmosClientOptions>): Promise<CosmosClient> {
    if (!options.chainId || options.chainId.length === 0) {
      throw new Error(`Missing chainId`);
    }
    if (!options.mnemonic || options.mnemonic.length === 0) {
      throw new Error(`Missing mnemonic`);
    }
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

    const client = new CosmosClient(options as CosmosClientOptions);
    const signer = await client.getSigner();
    const gasPrice = GasPrice.fromString(`${client.gasPrice}${client.gasDenom}`);
    const tmClient = await Tendermint37Client.connect(client.rpcEndpoint);
    client.querier = await CosmWasmClient.create(tmClient);
    if (client.walletType === "injective") {
      const network: Network = Network[client.rpcEndpoint.indexOf("testnet") > -1 ? "TestnetK8s" : "MainnetK8s"];
      const endpoints = getNetworkEndpoints(network);
      const privateKey = client.getPrivateKey();
      client.cosmosAddress = privateKey.toAddress().toBech32(client.walletPrefix);
      client.signingClient = new MsgBroadcasterWithPk({
        privateKey,
        network,
        endpoints,
        simulateTx: true,
      });
    } else {
      client.cosmosAddress = (await signer.getAccounts())[0].address;
      client.signingClient = await SigningCosmWasmClient.createWithSigner(tmClient, signer, {
        gasPrice,
      });
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

  async tx(contract: string, payload: any): Promise<string> {
    let response: any;
    if (isCosmjsClient(this.signingClient!)) {
      const msgs: EncodeObject[] = [
        {
          typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
          value: MsgExecuteContract.fromPartial({
            sender: this.cosmosAddress!,
            contract,
            msg: Buffer.from(JSON.stringify(typeof payload === "string" ? JSON.parse(payload) : payload)),
          }),
        },
      ];
      const fees = await this.simulateFees(this.signingClient, this.cosmosAddress!, msgs);
      response = await this.signingClient.signAndBroadcast(this.cosmosAddress!, msgs, fees);
    } else if (isInjectiveClient(this.signingClient!)) {
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
  private async simulateFees(client: SigningCosmWasmClient, sender: string, msgs: EncodeObject[]): Promise<StdFee> {
    const gas = await client.simulate(sender, msgs, undefined);

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
  }
}
