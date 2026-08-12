import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";
import crypto from "crypto";

export async function GET(req: Request) {
  try {
    const userId = await workspaceUserId();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const domains = await prisma.indexerDomain.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json(domains);
  } catch (e: any) {
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const userId = await workspaceUserId("write");
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json();
    const { domain, template, moneyUrl, allowedBots } = body;

    if (!domain) {
      return NextResponse.json({ error: "Domain name is required" }, { status: 400 });
    }

    // Generate a secure, unique API key
    const apiKey = "idx_" + crypto.randomBytes(16).toString("hex");

    const newDomain = await prisma.indexerDomain.create({
      data: {
        userId,
        domain: domain.trim().toLowerCase(),
        template: template || "ecommerce",
        moneyUrl: moneyUrl || null,
        allowedBots: allowedBots || "google,bing,yandex,mailru,ai",
        apiKey,
        pagesCount: 0,
        subdomainsCount: 0,
      },
    });

    return NextResponse.json(newDomain);
  } catch (e: any) {
    if (e.code === "P2002") {
      return NextResponse.json({ error: "Domain already exists in your farm" }, { status: 400 });
    }
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const userId = await workspaceUserId("write");
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");

    if (!id) {
      return NextResponse.json({ error: "ID is required" }, { status: 400 });
    }

    // Verify ownership
    const domain = await prisma.indexerDomain.findFirst({
      where: { id, userId },
    });

    if (!domain) {
      return NextResponse.json({ error: "Domain not found" }, { status: 404 });
    }

    await prisma.indexerDomain.delete({
      where: { id },
    });

    return NextResponse.json({ success: true });
  } catch (e: any) {
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
