import { NextRequest, NextResponse } from "next/server";
import { CDN_CACHE } from "@/lib/cdnCache";
import { gateOutboundProxy } from "@/lib/outboundProxyGate";

export type NewsItem = {
  id: string;
  title: string;
  url: string;
  source: string;
  published_at: string;
};

const FEEDS = [
  { source: "CoinDesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss/" },
  { source: "Decrypt", url: "https://decrypt.co/feed" },
] as const;

const USER_AGENT = "Mozilla/5.0 (compatible; SiphonApp/1.0; +https://siphon.money)";

function decodeHtml(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'");
}

function extractTag(block: string, tag: string): string | null {
  const cdata = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, "i");
  const plain = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const match = block.match(cdata) ?? block.match(plain);
  const raw = match?.[1]?.trim();
  return raw ? decodeHtml(raw) : null;
}

function parseRss(xml: string, source: string): NewsItem[] {
  const items: NewsItem[] = [];
  const itemRegex = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let match: RegExpExecArray | null;

  while ((match = itemRegex.exec(xml)) !== null && items.length < 8) {
    const block = match[1];
    const title = extractTag(block, "title");
    const link = extractTag(block, "link");
    const pubDate = extractTag(block, "pubDate");
    const guid = extractTag(block, "guid");

    if (!title || !link) continue;

    const published = pubDate ? new Date(pubDate) : new Date();
    const published_at = Number.isNaN(published.getTime())
      ? new Date().toISOString()
      : published.toISOString();

    items.push({
      id: guid || link,
      title,
      url: link,
      source,
      published_at,
    });
  }

  return items;
}

async function fetchFeed(source: string, url: string): Promise<NewsItem[]> {
  const response = await fetch(url, {
    headers: { Accept: "application/rss+xml, application/xml, text/xml", "User-Agent": USER_AGENT },
    next: { revalidate: 180 },
  });

  if (!response.ok) {
    throw new Error(`${source} RSS error: ${response.status}`);
  }

  const xml = await response.text();
  return parseRss(xml, source);
}

export async function GET(req: NextRequest) {
  const limited = gateOutboundProxy(req, "news", Number(process.env.NEWS_RATE_MAX || "30"));
  if (limited) return limited;

  try {
    const results = await Promise.allSettled(
      FEEDS.map((feed) => fetchFeed(feed.source, feed.url)),
    );

    const articles = results
      .flatMap((result) => (result.status === "fulfilled" ? result.value : []))
      .sort(
        (a, b) =>
          new Date(b.published_at).getTime() - new Date(a.published_at).getTime(),
      )
      .slice(0, 8);

    if (articles.length === 0) {
      throw new Error("No news articles returned from feeds");
    }

    return NextResponse.json(articles, { headers: CDN_CACHE });
  } catch (error) {
    console.error("[API] news error:", error);
    return NextResponse.json({ error: "Failed to fetch crypto news" }, { status: 500 });
  }
}
