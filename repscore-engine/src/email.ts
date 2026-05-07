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

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8"/>
<style>
  body{margin:0;padding:0;background:#080b12;font-family:'Helvetica Neue',Arial,sans-serif;color:#e8edf8}
  .wrap{max-width:560px;margin:0 auto;padding:40px 20px}
  .card{background:#0d1120;border:1px solid #00e87a44;border-radius:12px;overflow:hidden}
  .header{background:#00e87a18;padding:24px 28px;border-bottom:1px solid #00e87a33;display:flex;align-items:center;gap:12px}
  .logo{width:32px;height:32px;border-radius:8px;background:#00e87a;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:13px;color:#000;font-family:monospace}
  .brand{font-size:16px;font-weight:800;color:#e8edf8}
  .body{padding:36px}
  .check{font-size:52px;text-align:center;margin-bottom:16px}
  .title{font-size:22px;font-weight:800;color:#00e87a;text-align:center;margin-bottom:10px}
  .desc{font-family:monospace;font-size:12px;color:#5a6a8a;line-height:1.7;text-align:center;margin-bottom:28px}
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
      <div class="brand">RepScore</div>
    </div>
    <div class="body">
      <div class="check">✓</div>
      <div class="title">Wallet Verified</div>
      <div class="desc">
        ${shortWallet} is now verified on RepScore.<br/>
        Your verified checkmark is live on your score page.<br/>
        Share it. It's permanent.
      </div>
      <a href="${scoreUrl}" class="cta">View my verified score →</a>
    </div>
    <div class="footer">
      Developed by <a href="https://superdevlabs.com">Super Dev Labs</a>
      · <a href="https://repscore.xyz">repscore.xyz</a>
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

