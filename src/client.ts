import {
  OfflineAminoSigner,
  Pubkey,
  SinglePubkey,
  encodeSecp256k1Pubkey,
  makeSignDoc as makeSignDocAmino,
} from "@cosmjs/amino";
import { CosmWasmClient, SigningCosmWasmClient, createWasmAminoConverters } from "@cosmjs/cosmwasm-stargate";
import { HdPath, Slip10RawIndex } from "@cosmjs/crypto";
import { fromBase64 } from "@cosmjs/encoding";
import { Int53 } from "@cosmjs/math";
import {
  DirectSecp256k1HdWallet,
  EncodeObject,
  OfflineDirectSigner,
  TxBodyEncodeObject,
  isOfflineDirectSigner,
  makeAuthInfoBytes,
  makeSignDoc,
} from "@cosmjs/proto-signing";
import {
  AminoTypes,
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
  BaseAccount,
  ChainRestAuthApi,
  InjectiveDirectEthSecp256k1Wallet,
  PrivateKey,
  getPublicKey,
} from "@injectivelabs/sdk-ts";
import { chains } from "chain-registry";
import { QueryAccountRequest, QueryClientImpl } from "cosmjs-types/cosmos/auth/v1beta1/query";
import { SignMode } from "cosmjs-types/cosmos/tx/signing/v1beta1/signing";
import { ServiceClientImpl, SimulateRequest } from "cosmjs-types/cosmos/tx/v1beta1/service";
import { AuthInfo, Fee, Tx, TxBody, TxRaw } from "cosmjs-types/cosmos/tx/v1beta1/tx";
import { MsgExecuteContract } from "cosmjs-types/cosmwasm/wasm/v1/tx";
import { Any } from "cosmjs-types/google/protobuf/any";
import Decimal from "decimal.js";
import Long from "long";
import { createDefaultTypes, encodePubkey } from "./utils";
import { wait, waitUntilAsync } from "ts-retry";

export type CosmosClientOptions = {
  chainId: string;
  mnemonic: string;
  walletPrefix: string;
  rpcEndpoint: string;
  rpcEndpoints: string[];
  coinType: number | string;
  gasDenom: string;
  gasPrice: number | string;
  gasAdjustment: number | string;
  walletType: "cosmos" | "injective";
  granter?: string;
  signer?: OfflineDirectSigner | OfflineAminoSigner;
  browserWallet?: string;
  connectionTimeout?: number;
};

export class CosmosClient {
  private constructor(options: CosmosClientOptions) {
    this.chainId = options.chainId;
    this.mnemonic = options.mnemonic;
    this.walletPrefix = options.walletPrefix;
    this.rpcEndpoint = options.rpcEndpoint;
    this.rpcEndpoints = options.rpcEndpoints;
    this.coinType = Number(options.coinType);
    this.gasDenom = options.gasDenom;
    this.gasPrice = Number(options.gasPrice);
    this.gasAdjustment = Number(options.gasAdjustment);
    this.walletType = options.walletType;
    this.granter = options.granter;
    this.signer = options.signer;
    this.browserWallet = this.signer ? options.browserWallet : "keplr";
    this.connectionTimeout = options.connectionTimeout || 30_000;
  }
  chainId: string;
  mnemonic: string;
  walletPrefix: string;
  rpcEndpoint: string;
  rpcEndpoints: string[];
  coinType: number;
  gasDenom: string;
  gasPrice: number;
  gasAdjustment: number;
  walletType: "cosmos" | "injective";
  signingClient?: SigningCosmWasmClient;
  querier?: CosmWasmClient;
  cosmosAddress?: string;
  granter?: string;
  signer?: OfflineDirectSigner | OfflineAminoSigner;
  browserWallet?: string;
  tmClient?: Tendermint37Client;
  connectionErrors: number = 0;
  connectionTimeout: number = 30000;
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
  private async getSigner(): Promise<OfflineDirectSigner | OfflineAminoSigner> {
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
    if (client.rpcEndpoint.indexOf(",") > -1) {
      client.rpcEndpoints = client.rpcEndpoint.split(",");
      client.rpcEndpoint = client.rpcEndpoints[0];
    } else {
      client.rpcEndpoints = [client.rpcEndpoint];
    }
    const signer = await client.getSigner();
    const gasPrice = GasPrice.fromString(`${client.gasPrice}${client.gasDenom}`);
    await client.setClients(client.rpcEndpoint);
    client.cosmosAddress = (await signer.getAccounts())[0].address;
    client.signingClient = await SigningCosmWasmClient.createWithSigner(client.tmClient!, signer, {
      gasPrice,
    });
    return client;
  }

  private async setClients(endpoint: string) {
    try {
      await waitUntilAsync(async () => {
        this.tmClient = await Tendermint37Client.connect(endpoint);
        this.querier = await CosmWasmClient.create(this.tmClient);
        this.connectionErrors = 0;
      }, 5000);
    } catch (e) {
      await this.addConnectionFailure();
    }
  }

  private async addConnectionFailure() {
    console.log("connection failure");
    this.connectionErrors++;
    if (this.connectionErrors > this.rpcEndpoints.length) {
      await wait(this.connectionTimeout);
      this.connectionErrors = 0;
    }
    this.rotateEndpoint();
    await wait(3000);
    await this.setClients(this.rpcEndpoint);
  }

  private rotateEndpoint() {
    const activeEndpointIndex = this.rpcEndpoints.indexOf(this.rpcEndpoint);
    const nextEndpointIndex = (activeEndpointIndex + 1) % this.rpcEndpoints.length;
    this.rpcEndpoint = this.rpcEndpoints[nextEndpointIndex];
  }

  async query(contractAddr: string, params: any): Promise<any> {
    if (!this.querier) {
      throw new Error("Client not initialized");
    }

    const payload = typeof params === "string" ? JSON.parse(params) : params;
    try {
      const response = await this.querier.queryContractSmart(contractAddr, payload);
      return response;
    } catch (e) {
      this.addConnectionFailure();
    }
  }

  async sign(
    signerAddress: string,
    messages: readonly EncodeObject[],
    memo: string,
    fee?: StdFee,
    explicitSignerData?: SignerData,
  ): Promise<TxRaw> {
    if (!this.signingClient) {
      throw new Error("Client not initialized");
    }

    try {
      const encodedMessages = messages.map((msg) => this.signingClient!.registry.encodeAsAny(msg));

      const {
        pubkey,
        sequence,
        accountNumber,
        txBodyBytes,
        authInfoBytes,
        fees: estimatedFees,
      } = await this.prepareTx(encodedMessages, fee, memo, explicitSignerData);

      const signer = await this.getSigner();
      if (isOfflineDirectSigner(signer)) {
        const signDoc = makeSignDoc(txBodyBytes, authInfoBytes, this.chainId, accountNumber);
        const { signature, signed } = await signer.signDirect(this.cosmosAddress!, signDoc);

        return TxRaw.fromPartial({
          bodyBytes: signed.bodyBytes,
          authInfoBytes: signed.authInfoBytes,
          signatures: [fromBase64(signature.signature)],
        });
      } else {
        const signMode = SignMode.SIGN_MODE_LEGACY_AMINO_JSON;
        const aminoTypes = new AminoTypes({ ...createDefaultTypes(), ...createWasmAminoConverters() });
        const msgs = messages.map((msg) => aminoTypes.toAmino(msg));
        const signDoc = makeSignDocAmino(msgs, estimatedFees, this.chainId, memo, accountNumber, sequence);
        const { signature, signed } = await signer.signAmino(signerAddress, signDoc);
        const signedTxBody = {
          messages: signed.msgs.map((msg) => aminoTypes.fromAmino(msg)),
          memo: signed.memo,
        };
        const signedTxBodyEncodeObject: TxBodyEncodeObject = {
          typeUrl: "/cosmos.tx.v1beta1.TxBody",
          value: signedTxBody,
        };
        const signedTxBodyBytes = this.signingClient.registry.encode(signedTxBodyEncodeObject);
        const signedGasLimit = Int53.fromString(signed.fee.gas).toNumber();
        const signedSequence = Int53.fromString(signed.sequence).toNumber();
        const signedAuthInfoBytes = makeAuthInfoBytes(
          [{ pubkey, sequence: signedSequence }],
          signed.fee.amount,
          signedGasLimit,
          signed.fee.granter,
          signed.fee.payer,
          signMode,
        );
        return TxRaw.fromPartial({
          bodyBytes: signedTxBodyBytes,
          authInfoBytes: signedAuthInfoBytes,
          signatures: [fromBase64(signature.signature)],
        });
      }
    } catch (e) {
      this.addConnectionFailure();
      return {} as TxRaw;
    }
  }

  async broadcast(txRaw: TxRaw): Promise<DeliverTxResponse> {
    const bytes = TxRaw.encode(txRaw).finish();
    try {
      const response = await (this.signingClient as SigningCosmWasmClient).broadcastTx(bytes);
      return response;
    } catch (e) {
      this.addConnectionFailure();
      return {} as DeliverTxResponse;
    }
  }

  async signAndBroadcast(msgs: EncodeObject[], memo?: string, fee?: StdFee): Promise<DeliverTxResponse> {
    const signedTx: TxRaw = await this.sign(this.cosmosAddress!, msgs, memo || "");
    try {
      const response = await this.broadcast(signedTx);
      return response;
    } catch (e) {
      this.addConnectionFailure();
      return {} as DeliverTxResponse;
    }
  }

  async getAccount(
    addr: string,
    isEthAccount: boolean = false,
  ): Promise<{ accountNumber: number; sequence: number; pubkey: Pubkey } | null> {
    try {
      if (!isEthAccount) {
        const response = await (this.signingClient as SigningCosmWasmClient).getAccount(addr);
        if (!response) {
          return null;
        }
        return {
          accountNumber: response.accountNumber,
          sequence: response.sequence,
          pubkey: response.pubkey ? response.pubkey : { type: "", value: "" },
        };
      } else if (isEthAccount) {
        const client = new QueryClient(this.tmClient!);
        const rpc = createProtobufRpcClient(client);
        const queryService = new QueryClientImpl(rpc);
        const response = await queryService.Account(QueryAccountRequest.fromPartial({ address: addr }));
        const decodedResponse = InjectiveTypesV1Beta1Account.EthAccount.decode(response.account!.value);

        return {
          accountNumber: Number(decodedResponse.baseAccount!.accountNumber),
          sequence: Number(decodedResponse.baseAccount!.sequence),
          pubkey: {
            type: decodedResponse.baseAccount?.pubKey?.typeUrl || "",
            value: Buffer.from(decodedResponse.baseAccount?.pubKey?.value || [])
              .slice(2)
              .toString("base64"),
          },
        };
      }
      return null;
    } catch (e) {
      this.addConnectionFailure();
      return null;
    }
  }

  private async prepareTx(
    msgs: EncodeObject[],
    fees?: StdFee,
    memo?: string,
    explicitSignerData?: SignerData,
  ): Promise<{
    fees: StdFee;
    accountNumber: number;
    sequence: number;
    txBodyBytes: Uint8Array;
    authInfoBytes: Uint8Array;
    pubkey: Any;
  }> {
    try {
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
        : await this.getAccount(this.cosmosAddress!, this.walletType === "injective");
      if (account === null) throw new Error("Account not found");

      const { sequence, accountNumber } = account;
      const accountFromSigner = (await (await this.getSigner()).getAccounts())![0];
      const pubkey = encodePubkey(encodeSecp256k1Pubkey(accountFromSigner.pubkey), this.walletType === "injective");

      const finalFees = fees || (await this.simulateFees(msgs));

      const authInfoBytes = makeAuthInfoBytes(
        [
          {
            pubkey,
            sequence,
          },
        ],
        finalFees.amount,
        new Decimal(finalFees.gas).toNumber(),
        finalFees.granter,
        finalFees.payer,
      );
      return {
        fees: finalFees,
        pubkey,
        accountNumber,
        sequence,
        txBodyBytes,
        authInfoBytes,
      };
    } catch (e) {
      this.addConnectionFailure();
      return {} as any;
    }
  }

  async tx(contract: string, payload: any): Promise<string> {
    if (!this.signingClient || !this.cosmosAddress) {
      throw new Error("Signing client not initialized");
    }
    try {
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

      const response = await this.signAndBroadcast(msgs);

      if (isDeliverTxFailure(response)) {
        throw new Error(`Tx failed: ${response.rawLog}`);
      }

      return response.transactionHash;
    } catch (e) {
      this.addConnectionFailure();
      return "";
    }
  }
  async simulateFees(msgs: EncodeObject[]): Promise<StdFee> {
    try {
      const client = new QueryClient(this.tmClient!);
      const rpc = createProtobufRpcClient(client);
      const queryService = new ServiceClientImpl(rpc);
      const account = await this.getAccount(this.cosmosAddress!, this.walletType === "injective");
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
            amount: gas
              .mul(new Decimal(this.gasAdjustment!))
              .round()
              .mul(new Decimal(this.gasPrice!))
              .ceil()
              .toFixed(0),
          },
        ],
        gas: gas.mul(new Decimal(this.gasAdjustment!)).round().toFixed(0),
        granter: this.granter,
      } as StdFee;
    } catch (e) {
      this.addConnectionFailure();
      return {} as any;
    }
  }
}
