import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";
import { fetchLLM } from "@/lib/llm";

export async function GET(req: Request) {
  try {
    const userId = await workspaceUserId();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const words = await prisma.indexerDictionary.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json(words.map(w => w.word));
  } catch (e: any) {
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const userId = await workspaceUserId("write");
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json();
    const { action, words, niche, aiProvider, aiApiKey } = body;

    if (action === "generate") {
      if (!niche) {
        return NextResponse.json({ error: "Niche topic is required" }, { status: 400 });
      }

      let generatedWords: string[] = [];

      if (aiProvider && aiApiKey) {
        const prompt = `Generate exactly 80 simple, single-word or short 2-word SEO keywords (no commas in phrases, no line numbers, no formatting) related to the topic "${niche}". Output them as a plain list, one keyword per line. Do not write any introduction or explanation. Output only the words themselves.`;
        const result = await fetchLLM(prompt, aiProvider, aiApiKey, 1500);
        if (result) {
          generatedWords = result
            .split("\n")
            .map(w => w.trim().replace(/^[-*•\d.]+\s*/, "")) // remove numbering/bullet points
            .filter(w => w.length > 0 && w.length < 40);
        }
      }

      // Fallback if LLM fails or is not provided
      if (generatedWords.length === 0) {
        const defaultNicheWords: Record<string, string[]> = {
          ecommerce: ["buy", "shop", "discount", "sale", "delivery", "price", "review", "brand", "best", "cheap", "quality", "store", "online", "shipping", "coupon", "wholesale", "retail", "orders", "guarantee", "refund"],
          crypto: ["bitcoin", "ethereum", "wallet", "blockchain", "mining", "trade", "token", "exchange", "ledger", "staking", "defi", "crypto", "price", "nodes", "halving", "nft", "smartcontract", "solana", "gas", "fees"],
          finance: ["loan", "credit", "insurance", "investment", "broker", "mortgage", "stocks", "dividend", "savings", "tax", "budget", "wealth", "forex", "bonds", "capital", "shares", "card", "rates", "interest", "bank"],
          general: ["news", "info", "guide", "tips", "how-to", "ideas", "best", "top", "review", "free", "cheap", "compare", "latest", "trending", "tutorial", "strategies", "secrets", "methods", "benefits", "results"],
        };

        const key = defaultNicheWords[niche.toLowerCase()] ? niche.toLowerCase() : "general";
        generatedWords = defaultNicheWords[key] || defaultNicheWords.general;
      }

      // Add to database
      const added = [];
      for (const word of generatedWords) {
        try {
          const entry = await prisma.indexerDictionary.create({
            data: {
              userId,
              word: word.toLowerCase().trim(),
            },
          });
          added.push(entry.word);
        } catch (e) {
          // ignore duplicates
        }
      }

      return NextResponse.json({ success: true, count: added.length, words: added });
    }

    // Default action: manual add
    if (!words) {
      return NextResponse.json({ error: "Words are required" }, { status: 400 });
    }

    const wordList = Array.isArray(words)
      ? words
      : words.split("\n").map((w: string) => w.trim()).filter((w: string) => w.length > 0);

    const added = [];
    for (const w of wordList) {
      try {
        const entry = await prisma.indexerDictionary.create({
          data: {
            userId,
            word: w.toLowerCase().trim(),
          },
        });
        added.push(entry.word);
      } catch (err) {
        // Ignore duplicates
      }
    }

    return NextResponse.json({ success: true, count: added.length });
  } catch (e: any) {
    console.error("[Indexer Dictionary Error]", e);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const userId = await workspaceUserId("write");
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    // Clear entire dictionary for this user
    await prisma.indexerDictionary.deleteMany({
      where: { userId },
    });

    return NextResponse.json({ success: true });
  } catch (e: any) {
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
