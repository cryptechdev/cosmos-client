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

const response = await client.query("your smart contract address", {
  // query payload
});

const txHash = await client.tx("your smart contract address", {
  // tx payload
});
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
