import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const repoRoot = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(.[^/]+)/, '$1:'));
const examplesDir = path.join(repoRoot, 'examples');

const providers = [
  'discord', 'github', 'gitlab', 'intercom', 'lemonsqueezy', 'mailchimp',
  'netlify', 'paddle', 'postmark', 'resend', 'sendgrid', 'shopify',
  'slack', 'stripe', 'twilio', 'vercel'
];

function runDemo(provider, variant) {
  const getPayloadFilename = (provider: string, variant: string): string => {
  if (variant === 'ok') return `payload-${provider}.json`;
  return `payload-${provider}-breaking.json`;
};

const cmd = `npm run build && node dist/cli.js diff --base examples/schema-${provider}.json --next examples/${getPayloadFilename(provider, variant)} --show-nonbreaking ${variant === 'json' ? '--json' : ''}`;
  try {
    const out = execSync(cmd, { cwd: repoRoot, encoding: 'utf8', timeout: 30000 });
    return out.trim();
  } catch (e) {
    if (e.status === 1) {
      // Breaking expected for breaking demos
      return e.stderr ? e.stderr.trim() : e.stdout.trim();
    }
    throw e;
  }
}

for (const provider of providers) {
  // ok txt
  const okTxt = runDemo(provider, 'ok');
  fs.writeFileSync(path.join(examplesDir, `demo-${provider}-ok.txt`), okTxt + '\\n');

  // breaking txt
  const breakingTxt = runDemo(provider, 'breaking');
  fs.writeFileSync(path.join(examplesDir, `demo-${provider}-breaking.txt`), breakingTxt + '\\n');

  // breaking json
  const breakingJson = runDemo(provider, 'json');
  fs.writeFileSync(path.join(examplesDir, `demo-${provider}-breaking.json`), breakingJson + '\\n');
}

console.log('Demo snapshots generated for all providers.');
