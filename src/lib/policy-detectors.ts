// Deterministic sensitive-data detectors: the model-free first stage of the
// data-policy guard (docs/roadmap.md, "brain review"). Pure and Worker-safe, so it
// runs inline on every write at no cost and sends content nowhere.
//
// Each detector trades recall for precision on purpose. It fires on shapes that are
// almost never innocent in a knowledge base (a live credential, a Luhn-valid card
// number, a labelled medical record number). Emails and phone numbers are NOT
// detected: person pages are full of them by design, and a guard that flags every
// person page trains everyone to ignore it.
//
// A detection carries offsets, never the matched text, so a caller can log it
// without copying the sensitive value somewhere new.

export type DetectionKind =
	| 'private-key'
	| 'api-token'
	| 'card-number'
	| 'us-ssn'
	| 'medical-record-number'
	| 'date-of-birth';

export type Severity = 'low' | 'medium' | 'high';

// What a person reads for each kind. The app shows these; `validate` keeps the kind
// ids, which an agent reads as well as a label and can quote back.
export const DETECTION_LABELS: Record<DetectionKind, string> = {
	'private-key': 'Private key',
	'api-token': 'API token',
	'card-number': 'Card number',
	'us-ssn': 'SSN',
	'medical-record-number': 'Medical record number',
	'date-of-birth': 'Date of birth'
};

export interface Detection {
	kind: DetectionKind;
	severity: Severity;
	start: number;
	end: number;
}

// Past this many detections in one text the file is plainly sensitive, and more
// rows only cost D1 writes.
export const MAX_DETECTIONS_PER_TEXT = 50;

interface Detector {
	kind: DetectionKind;
	severity: Severity;
	pattern: RegExp;
	// Optional second check on the match; false drops it.
	accept?: (match: RegExpExecArray) => boolean;
}

const TOKEN_PATTERNS = [
	/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, // AWS access key id
	/\bgh[pousr]_[A-Za-z0-9]{36,}\b/, // GitHub token
	/\bgithub_pat_[A-Za-z0-9_]{22,}\b/, // GitHub fine-grained token
	/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/, // Slack token
	/\bsk-[A-Za-z0-9_-]{32,}/, // OpenAI / Anthropic style secret key
	/\b(?:sk|rk)_live_[0-9A-Za-z]{20,}\b/, // Stripe live key
	/\bAIza[0-9A-Za-z_-]{35}\b/ // Google API key
];

const DETECTORS: Detector[] = [
	{
		kind: 'private-key',
		severity: 'high',
		pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/g
	},
	{
		kind: 'api-token',
		severity: 'high',
		pattern: new RegExp(TOKEN_PATTERNS.map((p) => p.source).join('|'), 'g')
	},
	{
		kind: 'card-number',
		severity: 'high',
		// 13 to 19 digits, optionally grouped by single spaces or hyphens, starting
		// with a real network's leading digit (3 Amex/Diners, 4 Visa, 5 Mastercard,
		// 6 Discover).
		pattern: /(?<![\w-])[3-6]\d{3}(?:[ -]?\d){9,15}(?![\w-])/g,
		accept: (m) => {
			const digits = m[0].replace(/\D/g, '');
			return (
				digits.length >= 13 && digits.length <= 19 && luhn(digits) && !/^(\d)\1+$/.test(digits)
			);
		}
	},
	{
		kind: 'us-ssn',
		severity: 'high',
		pattern: /(?<![\w-])(\d{3})-(\d{2})-(\d{4})(?![\w-])/g,
		// Area 000, 666 and 900-999, group 00 and serial 0000 are never issued.
		accept: (m) =>
			m[1] !== '000' && m[1] !== '666' && m[1][0] !== '9' && m[2] !== '00' && m[3] !== '0000'
	},
	{
		kind: 'medical-record-number',
		severity: 'high',
		// Labelled only: a bare number is indistinguishable from any other id.
		pattern: /\b(?:MRN|medical record (?:number|no\.?|#))\s*[:#]?\s*[A-Z0-9][A-Z0-9-]{4,}\b/gi
	},
	{
		kind: 'date-of-birth',
		severity: 'medium',
		pattern:
			/\b(?:DOB|D\.O\.B\.|date of birth)\s*[:-]?\s*(?:\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{4}-\d{2}-\d{2}|[A-Za-z]{3,9}\.? \d{1,2},? \d{4})/gi
	}
];

export function luhn(digits: string): boolean {
	let sum = 0;
	let double = false;
	for (let i = digits.length - 1; i >= 0; i--) {
		let d = digits.charCodeAt(i) - 48;
		if (double) {
			d *= 2;
			if (d > 9) d -= 9;
		}
		sum += d;
		double = !double;
	}
	return sum % 10 === 0;
}

// Every detection in `text`, in offset order, capped at MAX_DETECTIONS_PER_TEXT.
export function detectSensitive(text: string): Detection[] {
	const out: Detection[] = [];
	for (const d of DETECTORS) {
		d.pattern.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = d.pattern.exec(text)) !== null) {
			if (m[0].length === 0) {
				d.pattern.lastIndex++;
				continue;
			}
			if (d.accept && !d.accept(m)) continue;
			out.push({ kind: d.kind, severity: d.severity, start: m.index, end: m.index + m[0].length });
		}
	}
	out.sort((a, b) => a.start - b.start || a.end - b.end);
	return out.slice(0, MAX_DETECTIONS_PER_TEXT);
}
