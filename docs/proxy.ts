import { NextRequest, NextResponse } from 'next/server';
import {
  applySecurityHeaders,
  getCrawlerBlockReason,
  ROBOTS_DIRECTIVES,
} from '@/lib/botProtection';

function blockedResponse(reason: string): NextResponse {
  return new NextResponse('Access denied.', {
    status: 403,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Robots-Tag': ROBOTS_DIRECTIVES,
      'Cache-Control': 'no-store',
      'X-Crawler-Block': reason,
    },
  });
}

function withSecurityHeaders(response: NextResponse): NextResponse {
  applySecurityHeaders(response.headers);
  return response;
}

export default function proxy(request: NextRequest) {
  const userAgent = request.headers.get('user-agent');
  const pathname = request.nextUrl.pathname;

  const blockReason = getCrawlerBlockReason(userAgent, request.headers, pathname);
  if (blockReason) {
    return blockedResponse(blockReason);
  }

  return withSecurityHeaders(NextResponse.next());
}
