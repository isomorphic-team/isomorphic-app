// The magic-link sign-in email: subject, HTML and plain-text bodies.
//
// Pure, so `pnpm test:email` can pin it. The Worker sends it through Resend in
// `src/auth/config.ts`.
//
// This replaces Auth.js's stock template, which Gmail filed as "blatant spam":
// a hostname for a subject ("Sign in to mcp.example.com"), a lone "Sign in"
// button, and no sentence saying what the product is or why the mail arrived.
// That is the shape of a phishing message. What this adds is what a filter and
// a reader both look for: a product name in the subject and the From line, the
// address the link was requested for, where the link goes, when it expires, and
// a plain-text part that carries the same words rather than a bare URL.

export const PRODUCT_NAME = 'Isomorphic';

export interface SignInEmailInput {
	/** The magic link Auth.js generated. Used verbatim. */
	url: string;
	/** The address the link was requested for. */
	email: string;
	/** How long the link stays valid, in seconds (the provider's `maxAge`). */
	maxAgeSeconds: number;
}

export interface SignInEmail {
	subject: string;
	html: string;
	text: string;
}

export function signInSubject(): string {
	return `Your ${PRODUCT_NAME} sign-in link`;
}

/** "24 hours", "1 hour", "30 minutes". Rounds down to the unit that reads naturally. */
export function describeExpiry(seconds: number): string {
	const hours = Math.floor(seconds / 3600);
	if (hours >= 1) return hours === 1 ? '1 hour' : `${hours} hours`;
	const minutes = Math.max(1, Math.floor(seconds / 60));
	return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

export function escapeHtml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

// Mail clients auto-link anything shaped like a domain or an address. A second,
// unstyled link to the host reads as the thing to click, so a zero-width space
// after each dot keeps the text readable and unlinked (the same trick Auth.js
// uses on the host).
function unlinked(s: string): string {
	return escapeHtml(s).replace(/\./g, '.&#8203;').replace(/@/g, '@&#8203;');
}

export function composeSignInEmail({ url, email, maxAgeSeconds }: SignInEmailInput): SignInEmail {
	const host = new URL(url).host;
	const expiry = describeExpiry(maxAgeSeconds);
	const subject = signInSubject();

	const text = [
		`Sign in to ${PRODUCT_NAME}`,
		'',
		`Someone asked to sign in to ${PRODUCT_NAME} as ${email}. If that was you, open this link to finish signing in:`,
		'',
		url,
		'',
		`The link works once and expires in ${expiry}. It opens ${host}.`,
		'',
		`If you did not ask to sign in, ignore this email. Nobody can sign in as you without this link, and nothing about your account has changed.`,
		'',
		`${PRODUCT_NAME}: a team wiki your AI maintains.`
	].join('\n');

	const font = 'font-family: -apple-system, BlinkMacSystemFont, Helvetica, Arial, sans-serif;';
	const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(subject)}</title>
</head>
<body style="margin: 0; padding: 0; background: #f6f6f4;">
<div style="display: none; max-height: 0; overflow: hidden;">Finish signing in to ${PRODUCT_NAME}. The link expires in ${expiry}.</div>
<table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="background: #f6f6f4;">
<tr><td align="center" style="padding: 32px 16px;">
<table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="max-width: 520px; background: #ffffff; border-radius: 8px;">
<tr><td style="padding: 32px 32px 8px; ${font} font-size: 20px; font-weight: 600; color: #1a1a1a;">Sign in to ${PRODUCT_NAME}</td></tr>
<tr><td style="padding: 8px 32px; ${font} font-size: 15px; line-height: 22px; color: #3a3a3a;">Someone asked to sign in to ${PRODUCT_NAME} as <strong>${unlinked(email)}</strong>. If that was you, use the button below to finish signing in.</td></tr>
<tr><td style="padding: 16px 32px;">
<table role="presentation" border="0" cellspacing="0" cellpadding="0"><tr>
<td style="border-radius: 6px; background: #1a1a1a;"><a href="${escapeHtml(url)}" target="_blank" style="display: inline-block; padding: 12px 22px; ${font} font-size: 15px; font-weight: 600; color: #ffffff; text-decoration: none; border-radius: 6px;">Sign in to ${PRODUCT_NAME}</a></td>
</tr></table>
</td></tr>
<tr><td style="padding: 8px 32px; ${font} font-size: 13px; line-height: 20px; color: #6a6a6a;">The link works once and expires in ${expiry}. It opens ${unlinked(host)}.</td></tr>
<tr><td style="padding: 8px 32px 32px; ${font} font-size: 13px; line-height: 20px; color: #6a6a6a;">If you did not ask to sign in, ignore this email. Nobody can sign in as you without this link, and nothing about your account has changed.</td></tr>
</table>
<p style="margin: 16px 0 0; ${font} font-size: 12px; color: #8a8a8a;">${PRODUCT_NAME}: a team wiki your AI maintains.</p>
</td></tr>
</table>
</body>
</html>
`;

	return { subject, html, text };
}

export interface SendSignInEmailInput extends SignInEmailInput {
	apiKey: string;
	from: string;
}

/**
 * Send the sign-in email through Resend's HTTP API. Throws on a non-2xx
 * response, which Auth.js turns into its sign-in error page, so a rejected send
 * never reaches the "check your email" screen. `fetchImpl` is injectable so the
 * request body is testable without a network.
 */
export async function sendSignInEmail(
	input: SendSignInEmailInput,
	fetchImpl: typeof fetch = fetch
): Promise<void> {
	const { subject, html, text } = composeSignInEmail(input);
	const res = await fetchImpl('https://api.resend.com/emails', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${input.apiKey}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ from: input.from, to: input.email, subject, html, text })
	});
	if (!res.ok) {
		const detail = await res.text().catch(() => '');
		throw new Error(`Resend refused the sign-in email (${res.status}): ${detail}`);
	}
}
