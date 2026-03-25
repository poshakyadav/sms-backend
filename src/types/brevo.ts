export interface BrevoSendEmailRequest {
  sender: {
    name?: string;
    email: string;
  };
  to: Array<{
    email: string;
    name?: string;
  }>;
  subject: string;
  htmlContent?: string; // HTML body (required if no textContent or templateId)
  textContent?: string; // Plain text body (optional fallback)
  replyTo?: {
    email: string;
    name?: string;
  };
  cc?: Array<{
    email: string;
    name?: string;
  }>;
  bcc?: Array<{
    email: string;
    name?: string;
  }>;
  attachment?: Array<{
    url?: string; // Public URL to file
    content?: string; // Base64-encoded content
    name: string;
  }>;
  templateId?: number; // If using a Brevo template (overrides htmlContent/subject)
  params?: Record<string, any>; // Variables for template substitution, e.g., { name: 'User' }
  tags?: string[]; // For tracking
  scheduledAt?: string; // UTC ISO string, e.g., '2026-02-10T10:00:00Z'
}
