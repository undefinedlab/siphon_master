import { generateNote, generateFheKeyPair, encryptValueFhe, NoteSecrets, FheKeyPair } from "./crypto";
import { mapErrorCodeToException } from "./errors";
import { ethers } from "ethers";

export interface SiphonClientConfig {
  baseUrl: string;
  apiKey: string;
  privateKey?: string; // Optional: used to sign wallet requests
  timeout?: number;     // Default timeout in ms
}

export interface RequestOptions {
  timeout?: number;
  idempotencyKey?: string;
  chainId?: number | string;
}

export class SiphonClient {
  public readonly baseUrl: string;
  public readonly apiKey: string;
  public readonly privateKey?: string;
  public readonly defaultTimeout: number;

  constructor(config: SiphonClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.apiKey = config.apiKey;
    this.privateKey = config.privateKey;
    this.defaultTimeout = config.timeout ?? 10000; // 10s default
  }

  /**
   * Helper to perform requests with timeouts, idempotency, backoff, and error mapping.
   */
  private async request(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body?: any,
    options: RequestOptions = {}
  ): Promise<any> {
    const url = `${this.baseUrl}${path}`;
    const timeout = options.timeout ?? this.defaultTimeout;

    // Build headers
    const headers: Record<string, string> = {
      "Authorization": `Bearer ${this.apiKey}`,
      "Accept": "application/problem+json, application/json",
    };

    if (body) {
      headers["Content-Type"] = "application/json";
    }

    // Attach Idempotency-Key automatically for write requests (POST/PUT/DELETE)
    const isWrite = method !== "GET";
    let idempotencyKey = options.idempotencyKey;
    if (isWrite && !idempotencyKey) {
      idempotencyKey = crypto.randomUUID();
    }
    if (idempotencyKey) {
      headers["Idempotency-Key"] = idempotencyKey;
    }

    // Attach Wallet Authentication headers if privateKey and chainId are provided
    if (this.privateKey && options.chainId) {
      const wallet = new ethers.Wallet(this.privateKey);
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const message = `Siphon API v1:${options.chainId}:${timestamp}`;
      const signature = await wallet.signMessage(message);

      headers["X-Wallet-Address"] = wallet.address;
      headers["X-Signature"] = signature;
      headers["X-Timestamp"] = timestamp;
    }

    // Exponential Backoff + Jitter implementation
    const maxAttempts = 5;
    let attempt = 0;
    const baseDelayMs = 500;

    while (attempt < maxAttempts) {
      attempt++;
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), timeout);

      try {
        const response = await fetch(url, {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });

        clearTimeout(id);

        const contentType = response.headers.get("content-type") || "";
        let respBody: any = null;
        if (contentType.includes("json")) {
          respBody = await response.json();
        } else {
          respBody = await response.text();
        }

        if (response.status >= 200 && response.status < 300) {
          return respBody;
        }

        // Handle retryable status codes (429 and 503)
        const isRetryable = response.status === 429 || response.status === 503;
        if (isRetryable && attempt < maxAttempts) {
          // Check for Retry-After header
          let delayMs = baseDelayMs * Math.pow(2, attempt);
          const retryAfter = response.headers.get("Retry-After");
          if (retryAfter) {
            const parsedSeconds = parseInt(retryAfter, 10);
            if (!isNaN(parsedSeconds)) {
              delayMs = parsedSeconds * 1000;
            }
          } else {
            // Apply jitter
            delayMs = delayMs * (0.5 + Math.random() * 0.5);
          }
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }

        // Map standard error shape (RFC 7807) to typed exception
        const errorMsg = respBody && typeof respBody === "object" ? respBody.detail || respBody.title || "Request failed" : String(respBody);
        const errorCode = respBody && typeof respBody === "object" ? respBody.error_code : "unknown_error";
        const requestId = respBody && typeof respBody === "object" ? respBody.request_id : undefined;
        const errorType = respBody && typeof respBody === "object" ? respBody.type : undefined;

        throw mapErrorCodeToException(errorMsg, errorCode, response.status, requestId, errorType, errorMsg);
      } catch (err: any) {
        clearTimeout(id);

        // Network or timeout errors
        const isTimeout = err.name === "AbortError";
        const isNetwork = err instanceof TypeError; // fetch raises TypeError on network issues in Node/Bun

        if ((isTimeout || isNetwork) && attempt < maxAttempts) {
          let delayMs = baseDelayMs * Math.pow(2, attempt);
          delayMs = delayMs * (0.5 + Math.random() * 0.5);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }

        throw err;
      }
    }
  }

  // --- Sub-Namespaces ---

  public readonly notes = {
    list: async (chainId: number | string, options: RequestOptions = {}) => {
      const q = new URLSearchParams({ chain_id: String(chainId) }).toString();
      return this.request("GET", `/v1/notes?${q}`, undefined, {
        ...options,
        chainId,
      });
    },
    generate: (chainId: number, asset: string, amount: string): Promise<NoteSecrets> => {
      return generateNote(chainId, asset, amount);
    }
  };

  public readonly deposits = {
    create: async (
      chainId: number | string,
      asset: string,
      amount: string,
      precommitment: string,
      options: RequestOptions = {}
    ) => {
      return this.request(
        "POST",
        "/v1/deposits",
        { chain_id: Number(chainId), asset, amount, precommitment },
        { ...options, chainId }
      );
    },
    confirm: async (
      depositId: string,
      txHash: string,
      chainId: number | string,
      options: RequestOptions = {}
    ) => {
      return this.request(
        "POST",
        `/v1/deposits/${depositId}/confirmation`,
        { tx_hash: txHash },
        { ...options, chainId }
      );
    }
  };

  public readonly withdrawals = {
    create: async (
      chainId: number | string,
      asset: string,
      recipient: string,
      amount: string,
      proof: {
        stateRoot: string;
        nullifierHashes: string[];
        changeCommitment: string;
        pA: string[];
        pB: string[][];
        pC: string[];
      },
      options: RequestOptions = {}
    ) => {
      return this.request(
        "POST",
        "/v1/withdrawals",
        { chain_id: Number(chainId), asset, recipient, amount, proof },
        { ...options, chainId }
      );
    },
    confirm: async (
      withdrawalId: string,
      txHash: string,
      chainId: number | string,
      options: RequestOptions = {}
    ) => {
      return this.request(
        "POST",
        `/v1/withdrawals/${withdrawalId}/confirmation`,
        { tx_hash: txHash },
        { ...options, chainId }
      );
    }
  };

  public readonly consolidation = {
    create: async (
      chainId: number | string,
      asset: string,
      proof: {
        stateRoot: string;
        nullifierHashes: string[];
        mergedCommitment?: string | null;
        changeCommitment?: string | null;
        pA: string[];
        pB: string[][];
        pC: string[];
      },
      options: RequestOptions = {}
    ) => {
      return this.request(
        "POST",
        "/v1/notes/consolidation",
        { chain_id: Number(chainId), asset, proof },
        { ...options, chainId }
      );
    },
    confirm: async (
      consolidationId: string,
      txHash: string,
      chainId: number | string,
      options: RequestOptions = {}
    ) => {
      return this.request(
        "POST",
        `/v1/notes/consolidation/${consolidationId}/confirmation`,
        { tx_hash: txHash },
        { ...options, chainId }
      );
    }
  };

  public readonly strategies = {
    // Agent discovery: the catalog of strategy types + param schemas (API-key only, unmetered).
    functions: async (options: RequestOptions = {}) => {
      return this.request("GET", "/v1/strategies/functions", undefined, options);
    },
    // Dry-run validity (semantic + crypto); free, unmetered.
    validate: async (strategyData: any, options: RequestOptions = {}) => {
      return this.request("POST", "/v1/strategies/validate", strategyData, options);
    },
    create: async (strategyData: any, chainId: number | string, options: RequestOptions = {}) => {
      return this.request("POST", "/v1/strategies", strategyData, { ...options, chainId });
    },
    list: async (chainId: number | string, options: RequestOptions = {}) => {
      const q = new URLSearchParams({ chain_id: String(chainId) }).toString();
      return this.request("GET", `/v1/strategies?${q}`, undefined, { ...options, chainId });
    },
    get: async (strategyId: string, chainId: number | string, options: RequestOptions = {}) => {
      return this.request("GET", `/v1/strategies/${strategyId}`, undefined, { ...options, chainId });
    },
    abort: async (strategyId: string, chainId: number | string, options: RequestOptions = {}) => {
      return this.request("POST", `/v1/strategies/${strategyId}/abort`, {}, { ...options, chainId });
    }
  };

  public readonly account = {
    usage: async (options: RequestOptions = {}) => {
      return this.request("GET", "/v1/account/usage", undefined, options);
    }
  };

  public readonly fees = {
    quote: async (options: RequestOptions = {}) => {
      return this.request("GET", "/v1/fees/quote", undefined, options);
    }
  };

  /** Self-serve API keys: pack catalog (public), purchase + list (wallet-signed). */
  public readonly keys = {
    packs: async (options: RequestOptions = {}) => {
      return this.request("GET", "/v1/keys/packs", undefined, options);
    },
    list: async (chainId: number | string, options: RequestOptions = {}) => {
      return this.request("GET", "/v1/keys", undefined, { ...options, chainId });
    },
    purchase: async (
      chainId: number | string,
      packId: string,
      txHash: string,
      options: RequestOptions & { usdcMinor?: number } = {}
    ) => {
      const body: Record<string, unknown> = {
        chain_id: Number(chainId),
        pack_id: packId,
        tx_hash: txHash,
      };
      if (packId === "custom" && options.usdcMinor != null) {
        body.usdc_minor = options.usdcMinor;
      }
      return this.request("POST", "/v1/keys/purchase", body, { ...options, chainId });
    }
  };

  // --- Cursor Pagination Helper ---
  public async *paginate<T>(
    fetchPage: (cursor?: string) => Promise<{ items: T[]; next_cursor?: string }>,
    initialCursor?: string
  ): AsyncGenerator<T, void, unknown> {
    let cursor = initialCursor;
    while (true) {
      const page = await fetchPage(cursor);
      for (const item of page.items) {
        yield item;
      }
      if (!page.next_cursor) {
        break;
      }
      cursor = page.next_cursor;
    }
  }

  // --- FHE Helper Sub-Namespace ---
  public readonly fhe = {
    generateKeys: (): FheKeyPair => {
      return generateFheKeyPair();
    },
    encrypt: (clientKey: string, value: number): string => {
      return encryptValueFhe(clientKey, value);
    }
  };
}
