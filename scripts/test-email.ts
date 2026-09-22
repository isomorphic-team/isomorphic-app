// Golden test for the magic-link sign-in email. Pure: the Resend call runs
// against a stub fetch.
//
//   pnpm test:email
//
// What this exists to catch. Auth.js's stock email was filed as "blatant spam"
// by Gmail, so the replacement's content is the fix, and each property below is
// one a tidy-up could quietly drop: the product name in the subject, a
// plain-text part that says what the HTML says, the link surviving HTML
// escaping intact, and a rejected send failing the sign-in instead of showing
// "check your email" for a message that was never sent.

import {
	composeSignInEmail,
	describeExpiry,
	sendSignInEmail,
	PRODUCT_NAME
} from '../src/lib/signin-email.ts';

import { checker } from './check.ts';

const { check, done } = checker('sign-in email checks');

const url =
	'https://mcp.example.com/auth/callback/resend?callbackUrl=https%3A%2F%2Fmcp.example.com%2F&token=abc123&email=pat%40example.com';
const input = { url, email: 'pat@example.com', maxAgeSeconds: 24 * 60 * 60 };

console.log('\ncontent');
{
	const { subject, html, text } = composeSignInEmail(input);
	check(
		'subject names the product, not a hostname',
		subject === `Your ${PRODUCT_NAME} sign-in link`,
		subject
	);
	check('subject carries no hostname', !subject.includes('example.com'), subject);

	check('text carries the link verbatim', text.includes(`\n${url}\n`));
	check('text names the address the link was requested for', text.includes('pat@example.com'));
	check('text states the expiry', text.includes('expires in 24 hours'));
	check('text says where the link goes', text.includes('It opens mcp.example.com.'));
	check('text tells a non-requester what to do', text.includes('If you did not ask to sign in'));

	const href = url.replace(/&/g, '&amp;');
	check('html link is the magic link, attribute-escaped', html.includes(`href="${href}"`));
	check('html has exactly one link', (html.match(/<a /g) ?? []).length === 1);
	check('html names the address', html.includes('pat@&#8203;example.&#8203;com'));
	check('html states the expiry', html.includes('expires in 24 hours'));
}

console.log('\nescaping: the address is data, never markup');
{
	const { html } = composeSignInEmail({ ...input, email: '"><script>x</script>@example.com' });
	check('no raw tag from the address', !html.includes('<script>'));
	check('escaped instead', html.includes('&lt;script&gt;'));
}

console.log('\nexpiry wording');
{
	check('24h', describeExpiry(86400) === '24 hours');
	check('1h', describeExpiry(3600) === '1 hour');
	check('90 min rounds down to 1 hour', describeExpiry(5400) === '1 hour');
	check('30 min', describeExpiry(1800) === '30 minutes');
	check('1 min', describeExpiry(60) === '1 minute');
	check('under a minute never says 0', describeExpiry(10) === '1 minute');
}

console.log('\nsend: the Resend request');
{
	let seen: { url: string; init: RequestInit } | undefined;
	const ok = (async (u: string, init: RequestInit) => {
		seen = { url: u, init };
		return new Response('{"id":"x"}', { status: 200 });
	}) as unknown as typeof fetch;

	await sendSignInEmail({ ...input, apiKey: 're_test', from: 'Acme <login@example.com>' }, ok);
	const body = JSON.parse(String(seen?.init.body));
	const composed = composeSignInEmail(input);
	check('posts to the Resend emails endpoint', seen?.url === 'https://api.resend.com/emails');
	check(
		'bearer auth',
		(seen?.init.headers as Record<string, string>).Authorization === 'Bearer re_test'
	);
	check('from is the configured sender', body.from === 'Acme <login@example.com>');
	check('to is the requesting address', body.to === 'pat@example.com');
	check('sends our subject', body.subject === composed.subject);
	check('sends the html part', body.html === composed.html);
	check('sends the text part', body.text === composed.text);

	const refused = (async () =>
		new Response('{"message":"domain not verified"}', { status: 403 })) as unknown as typeof fetch;
	let threw: unknown;
	try {
		await sendSignInEmail({ ...input, apiKey: 're_test', from: 'x@example.com' }, refused);
	} catch (e) {
		threw = e;
	}
	check('a refused send throws', threw instanceof Error);
	check(
		'the error carries status and reason',
		threw instanceof Error &&
			threw.message.includes('403') &&
			threw.message.includes('domain not verified'),
		String(threw)
	);
}

done();
