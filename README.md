# Cosmos Client

## Installation

```bash
npm install @cryptech/cosmos-client
```

## Usage

```typescript
import { CosmosClient } from "@cryptech/cosmos-client";

const client = await CosmosClient.new({
  mnemonic: "your mnemonic",
  chainId: "your chain id",
});

// Get account info
const account = await client.getAccount("your account address");

// Simulate a transaction to get gas estimate as StdFee
const stdFee = await client.simulateFees(messagesAsEncodeObject);

// Smart contract query
const response = await client.query("your smart contract address", {
  // query payload
});

// Smart contract transaction
const txHash = await client.tx("your smart contract address", {
  // tx payload
});

/**
 * Messages As EncodeObject
 * 
 *
 * The messagesAsEncodeObject is an array of objects that contain the following properties:
 * source: import { EncodeObject } from "@cosmjs/proto-signing";
 *

  {
    typeUrl: string;
    value: any;
  }

 *
 * Example for a Smart Contract Execute Message (Using cosmjs-types/cosmwasm/wasm/v1/tx.proto)
 *

 {
   typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
   value: MsgExecuteContract.fromPartial({
     sender: this.sender,
     contract: this.contractAddress,
     msg: toUtf8(JSON.stringify({
       my_tx_message: {
         tx_props1,
         tx_props2
       }
     })),
     funds: [{
       denom: "uatom",
       amount: "1000000"
     }]
   })
 }

 */

// Sign and broadcast any messages in the same transaction
const response = await client.signAndBroadcast(messagesAsEncodeObject, "your optional memo", "your optional fee");

// Sign transaction and return a TxRaw object
const signedTx = await client.sign(messagesAsEncodeObject, "your optional memo", "your optional fee");

// Broadcast a signed TxRaw object
const response = await client.broadcast(signedTx);
```

By default, `Cosmos Client` will try to find the required chain info from the `chain-registry`. If you want to use a custom chain, you can pass the more options to the `CosmosClient.new` function.

```typescript
client = await CosmosClient.new({
  chainId: process.env.CHAIN_ID,
  mnemonic: process.env.MNEMONIC,
  walletPrefix: process.env.WALLET_PREFIX,
  rpcEndpoint: process.env.RPC,
  gasPrice: process.env.GAS_PRICE,
  gasAdjustment: process.env.GAS_ADJUSTMENT,
  gasDenom: process.env.DENOM,
  coinType: process.env.COIN_TYPE,
  granter: process.env.GRANTER,
});
```

## Supported Messages on Injective

- Bank::MsgSend
- Wasm::MsgExecuteContract

## Usage for non-Injective Cosmos chains

For non-Injective Cosmos chains, you have to option to use the `CosmosClient.signingClient` directly as it is an instance of CosmWasmSigningClient, which inherits from StargateClient.  
This allows you to not have to prepare EncodeObjects for messages and instead use the provided functions to create messages and send them directly.

```typescript

const balanceResponse = await client.signingClient.getBalance(address, searchDenom);
const storeCodeResponse = await client.signingClient.upload(senderAddress, wasmCode, fee);
const instantiateResponse = await client.signingClient.instantiate(senderAddress, codeId, msg, label, fee);
...

```
