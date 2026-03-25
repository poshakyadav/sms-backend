import { BrevoSendEmailRequest } from '../types/brevo'; // Adjust path

export async function sendTransactionalEmail(
  env: { BREVO_API_KEY: string }, // Workers env
  data: BrevoSendEmailRequest
): Promise<{ messageId: string } | { error: string }> {
  const url = 'https://api.brevo.com/v3/smtp/email';
  const headers = {
    'accept': 'application/json',
    'api-key': env.BREVO_API_KEY,
    'content-type': 'application/json',
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(data),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Brevo API error: ${response.status} - ${errorText}`);
    }

    const result = await response.json() as { messageId: string };
    return result;
  } catch (error) {
    console.error('Email sending failed:', error);
    return { error: (error as Error).message };
  }
}