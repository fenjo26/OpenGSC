import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";
import crypto from "crypto";

export async function GET(req: Request) {
  try {
    const userId = await workspaceUserId();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { searchParams } = new URL(req.url);
    const domainId = searchParams.get("domainId");
    const botType = searchParams.get("botType");
    const page = Math.max(1, parseInt(searchParams.get("page") || "1"));
    const limit = Math.min(250, Math.max(10, parseInt(searchParams.get("limit") || "50")));

    // 7-day retention filter for raw log inspection
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 7);

    const where: any = {
      domain: {
        userId,
      },
      timestamp: {
        gte: cutoff,
      },
    };

    if (domainId) where.domainId = domainId;
    if (botType) where.botType = botType;

    const [total, logs] = await Promise.all([
      prisma.indexerLog.count({ where }),
      prisma.indexerLog.findMany({
        where,
        orderBy: { timestamp: "desc" },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          domain: {
            select: {
              domain: true,
            },
          },
        },
      }),
    ]);

    return NextResponse.json({
      logs,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
    });
  } catch (e: any) {
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}


