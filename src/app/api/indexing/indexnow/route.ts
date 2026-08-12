import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { workspaceUserId } from "@/lib/team/workspace";

export async function POST(req: Request) {
  const userId = await workspaceUserId("act");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const body = await req.json();
    const { host, key, keyLocation, urls } = body;

    if (!host || !key || !urls || !Array.isArray(urls) || urls.length === 0) {
      return NextResponse.json({ error: "Missing required fields (host, key, urls)" }, { status: 400 });
    }

    // Submit to indexnow.org (which distributes to Bing, Yandex, etc.)
    const response = await fetch("https://api.indexnow.org/indexnow", {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        host,
        key,
        keyLocation: keyLocation || `https://${host}/${key}.txt`,
        urlList: urls,
      }),
    });

    if (response.status === 200 || response.status === 202) {
      return NextResponse.json({ ok: true, status: response.status });
    } else {
      const text = await response.text();
      return NextResponse.json({ error: `IndexNow responded with status ${response.status}: ${text}` }, { status: 400 });
    }
  } catch (error: any) {
    return NextResponse.json({ error: error.message || "Unknown error" }, { status: 500 });
  }
}
