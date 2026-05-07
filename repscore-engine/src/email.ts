// ============================================================
// RepScore — Email Service (Hostinger SMTP via nodemailer)
// ============================================================

import nodemailer from "nodemailer";

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.hostinger.com",
  port: parseInt(process.env.SMTP_PORT || "465"),
  secure: process.env.SMTP_PORT === "465" || !process.env.SMTP_PORT,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

const FROM = process.env.SMTP_FROM || "RepScore <alerts@repscore.xyz>";

// ── Score change alert ────────────────────────────────────────

export async function sendScoreChangeAlert(
  email: string,
  wallet: string,
  oldScore: number,
  newScore: number,
  newTier: string,
  label?: string
): Promise<void> {
  const change   = newScore - oldScore;
  const isUp     = change > 0;
  const arrow    = isUp ? "↑" : "↓";
  const color    = isUp ? "#00e87a" : "#ff4455";
  const shortWallet = wallet.slice(0, 6) + "..." + wallet.slice(-4);
  const walletLabel = label || shortWallet;
  const scoreUrl = `https://repscore.xyz/score?wallet=${wallet}`;
  const watchUrl = `https://repscore.xyz/watchlist`;

  const tierLabels: Record<string, string> = {
    LEGEND:      "✦ Legend",
    VERIFIED:    "✓ Verified",
    ESTABLISHED: "◈ Established",
    UNPROVEN:    "◌ Unproven",
    FLAGGED:     "⚑ Flagged",
    BLACKLISTED: "✕ Blacklisted",
  };

  const tierLabel = tierLabels[newTier] || newTier;

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<style>
  body{margin:0;padding:0;background:#080b12;font-family:'Helvetica Neue',Arial,sans-serif;color:#e8edf8}
  .wrap{max-width:560px;margin:0 auto;padding:40px 20px}
  .card{background:#0d1120;border:1px solid #1c2840;border-radius:12px;overflow:hidden}
  .header{background:#131929;padding:24px 28px;border-bottom:1px solid #1c2840;display:flex;align-items:center;gap:12px}
  .logo{width:32px;height:32px;border-radius:8px;background:#00e87a;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:13px;color:#000;font-family:monospace}
  .brand{font-size:16px;font-weight:800;color:#e8edf8}
  .body{padding:28px}
  .score-change{display:flex;align-items:center;gap:16px;background:#131929;border:1px solid #1c2840;border-radius:10px;padding:20px;margin-bottom:20px}
  .score-old{font-size:28px;font-weight:800;color:#5a6a8a;font-family:monospace;text-decoration:line-through}
  .arrow{font-size:24px;color:${color};font-weight:800}
  .score-new{font-size:36px;font-weight:800;color:${color};font-family:monospace}
  .tier-pill{display:inline-block;background:${color}18;color:${color};border:1px solid ${color}44;padding:4px 10px;border-radius:4px;font-size:10px;font-weight:600;font-family:monospace;letter-spacing:1px;margin-bottom:16px}
  .wallet-label{font-size:15px;font-weight:700;margin-bottom:4px}
  .wallet-addr{font-family:monospace;font-size:11px;color:#5a6a8a;margin-bottom:20px}
  .change-badge{display:inline-block;background:${color}18;color:${color};padding:6px 14px;border-radius:6px;font-family:monospace;font-size:13px;font-weight:700;margin-bottom:20px}
  .cta{display:inline-block;background:#00e87a;color:#000;padding:13px 28px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px;margin-right:10px}
  .cta-ghost{display:inline-block;background:transparent;color:#e8edf8;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600;font-size:13px;border:1px solid #1c2840}
  .footer{padding:20px 28px;border-top:1px solid #1c2840;font-family:monospace;font-size:10px;color:#5a6a8a;line-height:1.6}
  .footer a{color:#00e87a;text-decoration:none}
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <div class="header">
      <div class="logo">RS</div>
      <div class="brand">RepScore</div>
    </div>
    <div class="body">
      <div class="wallet-label">${walletLabel}</div>
      <div class="wallet-addr">${wallet}</div>

      <div class="score-change">
        <div class="score-old">${oldScore}</div>
        <div class="arrow">${arrow}</div>
        <div class="score-new">${newScore}</div>
      </div>

      <div class="tier-pill">${tierLabel}</div><br/>

      <div class="change-badge">${arrow} ${Math.abs(change)} point${Math.abs(change) !== 1 ? 's' : ''} ${isUp ? 'increase' : 'decrease'}</div>

      <p style="font-family:monospace;font-size:12px;color:#5a6a8a;line-height:1.7;margin-bottom:24px">
        This wallet's RepScore changed by ${Math.abs(change)} points. ${isUp
          ? "Their on-chain reputation improved — more launches survived, better holder retention, or lock behavior changed."
          : "Their on-chain reputation declined — possible new flags, liquidity events, or scoring data updated."
        }
      </p>

      <a href="${scoreUrl}" class="cta">View full score →</a>
      <a href="${watchUrl}" class="cta-ghost">Manage watchlist</a>
    </div>
    <div class="footer">
      You're receiving this because you're watching ${shortWallet} on RepScore.<br/>
      <a href="${watchUrl}">Manage your watchlist</a> · <a href="https://repscore.xyz">repscore.xyz</a><br/>
      Developed by <a href="https://superdevlabs.com">Super Dev Labs</a>
    </div>
  </div>
</div>
</body>
</html>`;

  await transporter.sendMail({
    from: FROM,
    to: email,
    subject: `RepScore Alert: ${walletLabel} ${arrow} ${Math.abs(change)} pts (now ${newScore}/1000)`,
    html,
  });

  console.log(`[Email] ✓ Alert sent to ${email} for ${shortWallet}`);
}

// ── Verification confirmed email ──────────────────────────────

export async function sendVerificationEmail(
  email: string,
  wallet: string
): Promise<void> {
  const shortWallet = wallet.slice(0, 6) + "..." + wallet.slice(-4);
  const scoreUrl = `https://repscore.xyz/score?wallet=${wallet}`;

  // Build verified certificate as inline SVG for email
  const certSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="560" height="336" viewBox="0 0 560 336">
    <defs>
      <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" style="stop-color:#0d1120"/>
        <stop offset="100%" style="stop-color:#080b12"/>
      </linearGradient>
    </defs>
    <rect width="560" height="336" fill="url(#bg)"/>
    <rect x="10" y="10" width="540" height="316" fill="none" stroke="#00e87a" stroke-width="1.5" stroke-opacity="0.4" rx="8"/>
    <rect x="18" y="18" width="524" height="300" fill="none" stroke="#00e87a" stroke-width="0.5" stroke-opacity="0.2" rx="6"/>
    <rect x="28" y="28" width="24" height="24" fill="#00e87a" rx="5"/>
    <text x="40" y="44" font-family="monospace" font-size="9" font-weight="800" fill="#000" text-anchor="middle">RS</text>
    <text x="60" y="38" font-family="monospace" font-size="11" font-weight="600" fill="rgba(232,237,248,0.7)">REPSCORE.XYZ</text>
    <text x="60" y="50" font-family="monospace" font-size="9" fill="rgba(90,106,138,0.6)">ON-CHAIN REPUTATION</text>
    <text x="280" y="148" font-family="monospace" font-size="64" font-weight="800" fill="#00e87a" text-anchor="middle">✓</text>
    <text x="280" y="178" font-family="monospace" font-size="20" font-weight="800" fill="#00e87a" text-anchor="middle" letter-spacing="4">VERIFIED OWNER</text>
    <line x1="140" y1="190" x2="420" y2="190" stroke="#00e87a" stroke-width="0.5" stroke-opacity="0.3"/>
    <text x="280" y="224" font-family="monospace" font-size="32" font-weight="800" fill="#00e87a" text-anchor="middle">${shortWallet}</text>
    <rect x="210" y="232" width="140" height="22" fill="#00e87a18" stroke="#00e87a44" stroke-width="1" rx="4"/>
    <text x="280" y="247" font-family="monospace" font-size="11" font-weight="600" fill="#00e87a" text-anchor="middle">✓ Verified</text>
    <text x="280" y="278" font-family="monospace" font-size="10" fill="rgba(90,106,138,0.7)" text-anchor="middle">Verified ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</text>
    <rect x="18" y="300" width="524" height="24" fill="rgba(13,17,32,0.9)" rx="0"/>
    <text x="280" y="316" font-family="monospace" font-size="8" fill="rgba(90,106,138,0.5)" text-anchor="middle">On-chain verified · repscore.xyz · Built by Super Dev Labs</text>
  </svg>`;

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8"/>
<style>
  body{margin:0;padding:0;background:#080b12;font-family:'Helvetica Neue',Arial,sans-serif;color:#e8edf8}
  .wrap{max-width:580px;margin:0 auto;padding:40px 20px}
  .card{background:#0d1120;border:1px solid #00e87a44;border-radius:12px;overflow:hidden}
  .header{background:#00e87a18;padding:24px 28px;border-bottom:1px solid #00e87a33;display:flex;align-items:center;gap:12px}
  .logo{width:32px;height:32px;border-radius:8px;background:#00e87a;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:13px;color:#000;font-family:monospace}
  .brand{font-size:16px;font-weight:800;color:#e8edf8}
  .body{padding:32px}
  .cert-wrap{background:#080b12;border:1px solid #00e87a33;border-radius:10px;padding:4px;margin-bottom:24px;text-align:center}
  .title{font-size:20px;font-weight:800;color:#00e87a;margin-bottom:8px}
  .desc{font-family:monospace;font-size:12px;color:#5a6a8a;line-height:1.7;margin-bottom:24px}
  .cta{display:block;background:#00e87a;color:#000;padding:14px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px;text-align:center}
  .footer{padding:20px 28px;border-top:1px solid #1c2840;font-family:monospace;font-size:10px;color:#5a6a8a}
  .footer a{color:#00e87a;text-decoration:none}
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <div class="header">
      <div class="logo">RS</div>
      <div class="brand">RepScore — Wallet Verified</div>
    </div>
    <div class="body">
      <div class="title">✓ ${shortWallet} is verified</div>
      <div class="desc">
        Your verified checkmark is live on RepScore.<br/>
        Your certificate is below — save it and share it.<br/>
        Post it on X. Drop it in your Telegram. It's permanent.
      </div>
      <div class="cert-wrap">
        ${certSvg}
      </div>
      <a href="${scoreUrl}" class="cta">View my verified score →</a>
    </div>
    <div class="footer">
      Developed by <a href="https://superdevlabs.com">Super Dev Labs</a>
      · <a href="https://repscore.xyz">repscore.xyz</a><br/>
      This certificate proves on-chain wallet ownership via RepScore verification.
    </div>
  </div>
</div>
</body>
</html>`;

  await transporter.sendMail({
    from: FROM,
    to: email,
    subject: `✓ Wallet verified on RepScore — ${shortWallet}`,
    html,
  });

  console.log(`[Email] ✓ Verification confirmation sent to ${email}`);
}

