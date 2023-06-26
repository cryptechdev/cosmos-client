import { DirectSecp256k1HdWallet } from "@cosmjs/proto-signing";
import { CosmosClient, CosmosClientOptions } from "../src";
import { chains } from "chain-registry";

describe("CosmosClient", () => {
  test("new cosmos client", async () => {
    const chain = chains.find((c) => c.chain_id === "osmosis-1")!;
    const mnemonic = (await DirectSecp256k1HdWallet.generate(12)).mnemonic;
    const client = await CosmosClient.new({
      mnemonic,
      chainId: chain.chain_id,
    } as Partial<CosmosClientOptions>);
    expect(client.walletPrefix).toBe(chain.bech32_prefix);
    expect(client.gasDenom).toBe(chain.fees!.fee_tokens[0].denom);
  });

  test("new injective client", async () => {
    const chain = chains.find((c) => c.chain_id === "injective-888")!;
    const mnemonic = (await DirectSecp256k1HdWallet.generate(12)).mnemonic;
    const client = await CosmosClient.new({
      mnemonic,
      chainId: chain.chain_id,
    } as Partial<CosmosClientOptions>);
    expect(client.walletPrefix).toBe(chain.bech32_prefix);
    expect(client.gasDenom).toBe(chain.fees!.fee_tokens[0].denom);
  });
});
