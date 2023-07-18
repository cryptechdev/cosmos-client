import { SigningCosmWasmClient } from "@cosmjs/cosmwasm-stargate";
import { MsgBroadcasterWithPk } from "@injectivelabs/sdk-ts";

// export const isCosmjsClient = (
//   client?: SigningCosmWasmClient | MsgBroadcasterWithPk,
// ): client is SigningCosmWasmClient => {
//   return client !== undefined && "registry" in client;
// };

// export const isInjectiveClient = (
//   client?: SigningCosmWasmClient | MsgBroadcasterWithPk,
// ): client is MsgBroadcasterWithPk => {
//   return client !== undefined && "privateKey" in client;
// };
