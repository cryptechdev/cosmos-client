import { SigningCosmWasmClient } from "@cosmjs/cosmwasm-stargate";
import { MsgBroadcasterWithPk } from "@injectivelabs/sdk-ts";

export const isCosmjsClient = (
  client: SigningCosmWasmClient | MsgBroadcasterWithPk,
): client is SigningCosmWasmClient => {
  return "registry" in client;
};

export const isInjectiveClient = (
  client: SigningCosmWasmClient | MsgBroadcasterWithPk,
): client is MsgBroadcasterWithPk => {
  return "privateKey" in client;
};
