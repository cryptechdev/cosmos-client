import { chains } from "chain-registry";
import { CosmosClient, CosmosClientOptions } from "../src";
import { TxClient } from "@injectivelabs/sdk-ts";

describe("Key", () => {
  test("can get public key from injective account", async () => {
    const chain = chains.find((c) => c.chain_id === "injective-888")!;
    // inj1e7vn3ee24fx4c2wl9fvngtwvwtg8a28jw2v9qj
    const mnemonic = "acquire wrong unveil divert sign kidney random siren empty glad find surface";

    const client = await CosmosClient.new({
      mnemonic,
      chainId: chain.chain_id,
    } as Partial<CosmosClientOptions>);
    const txClient = new TxClient();
    const account = await client.getAccount(client.cosmosAddress!, true);
    console.log(account);
    expect(account).toBeDefined();
  }, 60000);
  test("can get public key from non-injective account", async () => {
    const chain = chains.find((c) => c.chain_id === "theta-testnet-001")!;
    // cosmos1esk409ur5wjhvpqj7salj4r093usjdup73umtj
    const mnemonic = "acquire wrong unveil divert sign kidney random siren empty glad find surface";

    const client = await CosmosClient.new({
      mnemonic,
      chainId: chain.chain_id,
    } as Partial<CosmosClientOptions>);
    console.log(client.cosmosAddress);

    const account = await client.getAccount(client.cosmosAddress!, false);
    console.log(account);
    expect(account).toBeDefined();
  }, 60000);
});
