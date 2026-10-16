// api/cron-sniper-plan-if-needed.js — Vercel Cron → sniper-bot 'Sniper Daily' (cmd=plan-if-needed)
import { dispatch } from './_sniper.js';
export default function handler(req, res) {
  return dispatch(req, res, 'sniper-daily.yml', { cmd: 'plan-if-needed' });
}
