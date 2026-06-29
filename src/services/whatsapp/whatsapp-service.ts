// src/services/whatsapp/whatsapp-service.ts
//
// THE only file in the codebase that talks to Meta's Graph API.
// All WhatsApp modules go through this class.
// Uses plain fetch (no SDK) — Cloudflare Workers compatible.
//
// API version: v21.0 (stable as of 2025-2026)
// Base: https://graph.facebook.com/v21.0

import { WhatsappTemplateComponent } from "../../types/whatsapp";

const GRAPH_API_VERSION = "v21.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

// ── Meta API response shapes (only fields we actually read) ──────────────────

export interface MetaSendMessageResponse {
  messaging_product: "whatsapp";
  contacts: Array<{ input: string; wa_id: string }>;
  messages: Array<{
    id: string; // wamid — up to 128 chars
    message_status?: string; // "accepted" | "held_for_quality_assessment"
  }>;
}

export interface MetaTemplateListResponse {
  data: Array<{
    id: string;
    name: string;
    status: string; // "APPROVED" | "PENDING" | "REJECTED" | "PAUSED" | "DISABLED"
    category: string; // "UTILITY" | "MARKETING" | "AUTHENTICATION"
    language: string;
    components: Array<{
      type: string;
      text?: string;
      format?: string;
      buttons?: Array<{
        type: string;
        text: string;
        url?: string;
        phone_number?: string;
      }>;
    }>;
    quality_score?: { score: string };
  }>;
  paging?: { cursors: { before: string; after: string }; next?: string };
}

export interface MetaErrorResponse {
  error: {
    message: string;
    type: string;
    code: number;
    fbtrace_id: string;
    error_subcode?: number;
    error_data?: { details: string };
  };
}

// ── WhatsAppService ───────────────────────────────────────────────────────────

export class WhatsappService {
  private readonly authHeader: string;

  constructor(
    private readonly accessToken: string,
    private readonly phoneNumberId: string,
    private readonly wabaId: string
  ) {
    this.authHeader = `Bearer ${accessToken}`;
  }

  // ── Internal fetch wrapper ──────────────────────────────────────────────────

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: Record<string, unknown>
  ): Promise<T> {
    const url = `${GRAPH_BASE}${path}`;
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: this.authHeader,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const json = (await response.json()) as T | MetaErrorResponse;

    if (!response.ok) {
      const err = json as MetaErrorResponse;
      const msg =
        err?.error?.message || `Meta API error (HTTP ${response.status})`;
      const code = err?.error?.code;
      const details = err?.error?.error_data?.details;
      throw new WhatsappApiError(msg, code ?? response.status, details);
    }

    return json as T;
  }

  // ── SEND TEMPLATE MESSAGE ───────────────────────────────────────────────────
  //
  // The primary call. Sends a single pre-approved template message to one
  // recipient. Per Meta docs, the body parameters array MUST match the
  // number of {{N}} placeholders in the template body exactly.
  //
  // API: POST /{PHONE_NUMBER_ID}/messages
  // Docs: https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-messages/

  async sendTemplate(params: {
    to: string; // E.164 WITHOUT + e.g. "919876543210"
    templateName: string;
    languageCode: string; // "en" | "hi" | "en_US" etc.
    bodyParameters: string[]; // ordered values for {{1}}, {{2}}, ...
    headerText?: string; // optional header override (text templates)
  }): Promise<MetaSendMessageResponse> {
    // Build body component (always present for our templates)
    const components: WhatsappTemplateComponent[] = [
      {
        type: "body",
        parameters: params.bodyParameters.map((text) => ({
          type: "text",
          text,
        })),
      },
    ];

    // Optionally add header text component
    if (params.headerText) {
      components.unshift({
        type: "header",
        parameters: [{ type: "text", text: params.headerText }],
      });
    }

    return this.request<MetaSendMessageResponse>(
      "POST",
      `/${this.phoneNumberId}/messages`,
      {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: params.to,
        type: "template",
        template: {
          name: params.templateName,
          language: { code: params.languageCode },
          components,
        },
      }
    );
  }

  // ── GET ALL TEMPLATES FROM WABA ─────────────────────────────────────────────
  //
  // Fetches all templates registered in our WABA, handling pagination.
  // Called by the template sync endpoint.
  //
  // API: GET /{WABA_ID}/message_templates
  // Fields we use: id, name, status, category, language, components

  async getTemplates(): Promise<MetaTemplateListResponse["data"]> {
    const allTemplates: MetaTemplateListResponse["data"] = [];
    let url = `/${this.wabaId}/message_templates?fields=id,name,status,category,language,components,quality_score&limit=100`;

    // Paginate through all pages
    while (url) {
      const page = await this.request<MetaTemplateListResponse>("GET", url);
      allTemplates.push(...page.data);
      url = page.paging?.next
        ? page.paging.next.replace(GRAPH_BASE, "") // strip base for relative request
        : "";
    }

    return allTemplates;
  }

  // ── MARK MESSAGE AS READ ────────────────────────────────────────────────────
  //
  // Sends a "read receipt" to Meta for an inbound message.
  // This shows the double blue tick on the sender's phone.
  // Call this when school admin views the inbound message.

  async markAsRead(waMessageId: string): Promise<{ success: boolean }> {
    await this.request("POST", `/${this.phoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      status: "read",
      message_id: waMessageId,
    });
    return { success: true };
  }

  // ── WEBHOOK VERIFICATION ─────────────────────────────────────────────────────
  //
  // Meta sends a GET request with hub.mode, hub.verify_token, hub.challenge.
  // We respond with hub.challenge if the verify_token matches our secret.
  // This is a pure string comparison — no crypto needed.

  static verifyWebhook(
    mode: string,
    token: string,
    expectedToken: string
  ): boolean {
    return mode === "subscribe" && token === expectedToken;
  }
}

// ── Custom error class ────────────────────────────────────────────────────────

export class WhatsappApiError extends Error {
  constructor(
    message: string,
    public readonly code: number,
    public readonly details?: string
  ) {
    super(message);
    this.name = "WhatsappApiError";
  }

  /** Whether this error is due to an invalid/unregistered phone number. */
  get isInvalidPhone(): boolean {
    // Meta error code 131047: message failed to send because more than 24 hours have passed
    // Meta error code 131006: recipient phone number not in allowed list (test mode)
    // Meta error code 131026: message undeliverable — recipient not on WhatsApp
    return [131006, 131026, 131047].includes(this.code);
  }

  /** Whether this is a template-related error. */
  get isTemplateError(): boolean {
    // Meta error code 132000: template not found / not approved
    // Meta error code 132001: template hydration error (wrong parameter count)
    return [132000, 132001].includes(this.code);
  }

  /** Whether this is a rate-limit error (retry after backoff). */
  get isRateLimit(): boolean {
    return this.code === 130429 || this.code === 80007;
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function getWhatsappService(env: {
  WHATSAPP_ACCESS_TOKEN: string;
  WHATSAPP_PHONE_NUMBER_ID: string;
  WHATSAPP_WABA_ID: string;
}): WhatsappService {
  if (
    !env.WHATSAPP_ACCESS_TOKEN ||
    !env.WHATSAPP_PHONE_NUMBER_ID ||
    !env.WHATSAPP_WABA_ID
  ) {
    throw new Error(
      "WhatsApp not configured. Set WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_WABA_ID in env."
    );
  }
  return new WhatsappService(
    env.WHATSAPP_ACCESS_TOKEN,
    env.WHATSAPP_PHONE_NUMBER_ID,
    env.WHATSAPP_WABA_ID
  );
}
