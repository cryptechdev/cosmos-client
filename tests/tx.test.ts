import { EncodeObject } from "@cosmjs/proto-signing";
import { chains } from "chain-registry";
import { MsgExecuteContract } from "cosmjs-types/cosmwasm/wasm/v1/tx";
import { CosmosClient, CosmosClientOptions } from "../src";

describe("Tx", () => {
  test("can broadcast MsgExecuteContract via tx()", async () => {
    const chain = chains.find((c) => c.chain_id === "injective-888")!;
    // inj1e7vn3ee24fx4c2wl9fvngtwvwtg8a28jw2v9qj
    const mnemonic = "acquire wrong unveil divert sign kidney random siren empty glad find surface";

    const client = await CosmosClient.new({
      mnemonic,
      chainId: chain.chain_id,
    } as Partial<CosmosClientOptions>);
    const response = await client.tx("inj18ga7tg6k67snh77eh5scatcmsse0fmkedgn4kg", {
      receive_message_cosmos: {},
    });
    expect(response).toBeDefined();
  }, 60000);
  test("can broadcast MsgExecuteContract via signAndBroadcast", async () => {
    const chain = chains.find((c) => c.chain_id === "injective-888")!;
    // inj1e7vn3ee24fx4c2wl9fvngtwvwtg8a28jw2v9qj
    const mnemonic = "acquire wrong unveil divert sign kidney random siren empty glad find surface";

    const client = await CosmosClient.new({
      mnemonic,
      chainId: chain.chain_id,
    } as Partial<CosmosClientOptions>);
    const msgs: EncodeObject[] = [
      {
        typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
        value: MsgExecuteContract.fromPartial({
          sender: client.cosmosAddress!,
          contract: "inj18ga7tg6k67snh77eh5scatcmsse0fmkedgn4kg",
          msg: Buffer.from(JSON.stringify({ receive_message_cosmos: {} })),
        }),
      },
    ];
    const response = await client.signAndBroadcast(msgs);
    expect(response).toBeDefined();
  }, 60000);
});
