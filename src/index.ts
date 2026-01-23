import fetch from 'node-fetch';
import 'reflect-metadata';
import * as express from 'express';
import * as bodyParser from 'body-parser';
import { Request, Response } from 'express';
import { Routes } from './routes';
import dataSource from './data-source';
import { DataSource } from 'typeorm';

import { PushLog } from './entity/PushLog';
import { TokenToTxid } from './entity/TokenToTxid';
import { TokenToAddress } from './entity/TokenToAddress';
import { ADDRESS_IGNORE_LIST } from './address-ignore-list';

// NEW entities (your custom tables)
import { GcPushToken } from './entity/GcPushToken';
import { GcOnchainSubscription } from './entity/GcOnchainSubscription';

require('dotenv').config();
const helmet = require('helmet');
const cors = require('cors');

const jwt = require('jsonwebtoken');
const bitcoinMessage = require('bitcoinjs-message');
const { GoogleAuth } = require('google-auth-library');

if (
  !process.env.JAWSDB_MARIA_URL ||
  !process.env.GOOGLE_KEY_FILE ||
  !process.env.GOOGLE_PROJECT_ID ||
  !process.env.GC_JWT_SECRET
) {
  console.error('not all env variables set');
  process.exit(1);
}

let connection: DataSource;

// ------------------------
// housekeeping (existing)
// ------------------------
const pushLogPurge = () => {
  console.log('purging PushLog...');
  const today = new Date();
  connection
    .createQueryBuilder()
    .delete()
    .from(PushLog)
    .where('created <= :currentDate', { currentDate: new Date(today.getTime() - 3 * 24 * 60 * 60 * 1000) })
    .execute()
    .then(() => console.log('PushLog purged ok'))
    .catch((error: any) => console.log('error purging PushLog:', error));
};

const purgeOldTxidSubscriptions = () => {
  console.log('purging TokenToTxid...');
  const today = new Date();
  connection
    .createQueryBuilder()
    .delete()
    .from(TokenToTxid)
    .where('created <= :currentDate', { currentDate: new Date(today.getTime() - 3 * 30 * 24 * 60 * 60 * 1000) }) // 3 mo
    .execute()
    .then(() => console.log('TokenToTxid purged ok'))
    .catch((error: any) => console.log('error purging TokenToTxid:', error));
};

const purgeIgnoredAddressesSubscriptions = () => {
  console.log('Purging addresses subscriptions...');
  connection
    .createQueryBuilder()
    .delete()
    .from(TokenToAddress)
    .where('address IN (:...id)', { id: ADDRESS_IGNORE_LIST })
    .execute()
    .then(() => console.log('Addresses subscriptions purged ok'))
    .catch((error: any) => console.log('error purging addresses subscriptions:', error));
};

const killSleepingMySQLProcesses = () => {
  console.log('Checking for sleeping MySQL processes...');
  const query = `
    SELECT id, user, host, db, command, time, state, info
    FROM information_schema.processlist 
    WHERE command = 'Sleep' AND time > 100 AND id != CONNECTION_ID()
  `;

  connection
    .query(query)
    .then((sleepingProcesses: any[]) => {
      if (sleepingProcesses.length > 0) {
        console.log(`Found ${sleepingProcesses.length} old sleeping processes`);
        const killPromises = sleepingProcesses.map((process: any) => {
          console.log(
            `Killing process ID ${process.id} (user: ${process.user}, host: ${process.host}, sleeping for ${process.time}s)`,
          );
          return connection
            .query(`KILL ${process.id}`)
            .then(() => console.log(`Successfully killed process ${process.id}`))
            .catch((error: any) => console.log(`Error killing process ${process.id}:`, error.message));
        });
        return Promise.all(killPromises);
      } else {
        console.log('No old sleeping processes found');
      }
    })
    .catch((error: any) => {
      console.log('Error checking sleeping processes:', error.message);
    });
};

// ------------------------
// GC auth nonce (one-time)
// ------------------------
const GC_NONCE_TTL_MS = 120 * 1000;
const gcNonces = new Map<string, number>(); // nonce -> expiresAt (ms)

// ------------------------
// JWT middleware
// ------------------------
function gcRequireJwt(req: any, res: any, next: any) {
  const h = req.headers?.authorization || '';
  const m = /^Bearer\s+(.+)$/.exec(String(h));
  if (!m) return res.status(401).json({ ok: false, error: 'missing authorization header' });

  try {
    const payload = jwt.verify(m[1], process.env.GC_JWT_SECRET);
    req.gcJwt = payload;
    return next();
  } catch (e: any) {
    return res.status(401).json({ ok: false, error: 'invalid token', detail: String(e?.message ?? e) });
  }
}

// ------------------------
// FCM send (HTTP v1) DATA-ONLY
// ------------------------
const auth = new GoogleAuth({
  keyFile: process.env.GOOGLE_KEY_FILE,
  scopes: ['https://www.googleapis.com/auth/firebase.messaging'],
});

async function gcSendFcm(token: string, data: Record<string, string>) {
  const client = await auth.getClient();
  const accessTokenResp = await client.getAccessToken();
  const accessToken = accessTokenResp?.token;
  if (!accessToken) throw new Error('no google access token');

  const projectId = String(process.env.GOOGLE_PROJECT_ID || '').trim();
  if (!projectId) throw new Error('GOOGLE_PROJECT_ID missing');

  const url = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;

  // DATA-ONLY (no "notification" object!)
  const payload = {
    message: {
      token,
      android: { priority: 'HIGH' },
      data,
    },
  };

  const r = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const text = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${text}`);
  return JSON.parse(text);
}

async function gcSendPushToSubscriber(subscriberAddress: string, data: Record<string, string>) {
  const repo = connection.getRepository(GcPushToken);
  const tokens = await repo.find({ where: { address: subscriberAddress } as any });

  if (!tokens.length) {
    return { ok: true, note: 'no push tokens for subscriber', results: [] as any[] };
  }

  const results: any[] = [];
  for (const t of tokens) {
    if (String((t as any).platform) !== 'android') {
      results.push({ platform: (t as any).platform, ok: false, error: 'platform not supported in this build' });
      continue;
    }
    try {
      const resp = await gcSendFcm(String((t as any).token), data);
      results.push({ platform: (t as any).platform, ok: true, messageId: resp?.name ?? resp?.messageId ?? resp });
    } catch (e: any) {
      results.push({ platform: (t as any).platform, ok: false, error: String(e?.message ?? e) });
    }
  }
  return { ok: true, results };
}

// ------------------------
// main
// ------------------------
dataSource
  .initialize()
  .then(async (c: DataSource) => {
    console.log('db connected');
    connection = c;

    purgeIgnoredAddressesSubscriptions();
    pushLogPurge();
    purgeOldTxidSubscriptions();
    killSleepingMySQLProcesses();

    setInterval(pushLogPurge, 3600 * 1000);
    setInterval(killSleepingMySQLProcesses, 100 * 1000);

    const app = express();
    app.use(bodyParser.json());
    app.use(cors());
    app.use(helmet.hidePoweredBy());
    app.use(helmet.hsts());

    // ---------- base health/info ----------
    app.get('/health', (_req, res) => res.status(200).send('ok'));

    app.get('/gc/info', (_req, res) => {
      res.json({
        name: 'GroundControl',
        version: process.env.npm_package_version ?? 'dev',
        time: new Date().toISOString(),
      });
    });

    // ---------- auth: nonce ----------
    app.post('/gc/auth/nonce', (_req, res) => {
      const nonce = Math.random().toString(36).slice(2);
      const expiresAt = Date.now() + GC_NONCE_TTL_MS;
      gcNonces.set(nonce, expiresAt);
      res.json({ nonce, expiresInSec: Math.floor(GC_NONCE_TTL_MS / 1000) });
    });

    // ---------- auth: verify -> JWT ----------
    app.post('/gc/auth/verify', (req, res) => {
      const { nonce, signature, address } = req.body ?? {};

      if (!nonce || !signature || !address) {
        return res.status(400).json({ ok: false, error: 'missing nonce/signature/address' });
      }

      const expiresAt = gcNonces.get(String(nonce));
      if (!expiresAt) return res.status(401).json({ ok: false, error: 'unknown nonce' });
      if (Date.now() > expiresAt) {
        gcNonces.delete(String(nonce));
        return res.status(401).json({ ok: false, error: 'nonce expired' });
      }

      gcNonces.delete(String(nonce)); // one-time use

      try {
        const verified = bitcoinMessage.verify(String(nonce), String(address), String(signature));
        if (!verified) return res.status(401).json({ ok: false, verified: false, error: 'signature invalid' });

        const token = jwt.sign(
          { typ: 'gc-session', sub: String(address), address: String(address) },
          process.env.GC_JWT_SECRET,
          { expiresIn: '24h' },
        );

        return res.json({ ok: true, verified: true, token });
      } catch (e: any) {
        return res.status(401).json({ ok: false, verified: false, error: String(e?.message ?? e) });
      }
    });

    // ---------- jwt utils ----------
    app.get('/gc/me', gcRequireJwt, (req: any, res) => res.json({ ok: true, session: req.gcJwt }));

    app.get('/gc/ping-auth', gcRequireJwt, (req: any, res) => {
      res.json({
        ok: true,
        pong: true,
        address: req.gcJwt?.address,
        time: new Date().toISOString(),
      });
    });

    // ---------- push: store token ----------
    app.post('/gc/push/register', gcRequireJwt, async (req: any, res) => {
      const address = String(req.gcJwt?.address || '');
      const { platform, token } = req.body ?? {};

      if (!address) return res.status(400).json({ ok: false, error: 'missing address in token' });
      if (!platform || !token) return res.status(400).json({ ok: false, error: 'missing platform/token' });

      try {
        const repo = connection.getRepository(GcPushToken);
        await repo.save({
          address,
          platform: String(platform),
          token: String(token),
        } as any);
        return res.json({ ok: true, address, platform: String(platform) });
      } catch (e: any) {
        return res.status(500).json({ ok: false, error: String(e?.message ?? e) });
      }
    });

    app.get('/gc/push/me', gcRequireJwt, async (req: any, res) => {
      const address = String(req.gcJwt?.address || '');
      if (!address) return res.status(400).json({ ok: false, error: 'missing address in token' });

      const repo = connection.getRepository(GcPushToken);
      const items = await repo.find({ where: { address } as any });

      return res.json({
        ok: true,
        address,
        items: items.map((i: any) => ({
          address: i.address,
          platform: i.platform,
          token: i.token ? `${String(i.token).slice(0, 10)}…` : '',
          updatedAt: i.updatedAt,
        })),
      });
    });

    // quick manual push test (data-only)
    app.post('/gc/push/test', gcRequireJwt, async (req: any, res) => {
      const address = String(req.gcJwt?.address || '');
      const { title, body } = req.body ?? {};

      if (!address) return res.status(400).json({ ok: false, error: 'missing address in token' });

      try {
        const r = await gcSendPushToSubscriber(address, {
          kind: 'gc_test_data',
          title: String(title || 'GC Test'),
          message: String(body || 'Hello'),
          channelId: 'bluewallet-notifications',
          platform: 'android',
        });
        return res.json({ ok: true, address, result: r });
      } catch (e: any) {
        return res.status(500).json({ ok: false, error: String(e?.message ?? e) });
      }
    });

    // ---------- onchain subscriptions ----------
    app.post('/gc/onchain/subscribe', gcRequireJwt, async (req: any, res) => {
      const subscriberAddress = String(req.gcJwt?.address || '');
      const { address } = req.body ?? {};

      if (!subscriberAddress) return res.status(400).json({ ok: false, error: 'missing subscriber address' });
      if (!address) return res.status(400).json({ ok: false, error: 'missing address' });

      const repo = connection.getRepository(GcOnchainSubscription);

      const existing = await repo.findOne({ where: { subscriberAddress, address: String(address) } as any });
      if (existing) {
        return res.json({ ok: true, subscriberAddress, address: String(address), already: true });
      }

      const saved = await repo.save({ subscriberAddress, address: String(address) } as any);
      return res.json({ ok: true, subscriberAddress, address: saved.address });
    });

    app.get('/gc/onchain/subscriptions', gcRequireJwt, async (req: any, res) => {
      const subscriberAddress = String(req.gcJwt?.address || '');
      if (!subscriberAddress) return res.status(400).json({ ok: false, error: 'missing subscriber address' });

      const repo = connection.getRepository(GcOnchainSubscription);
      const items = await repo.find({ where: { subscriberAddress } as any });

      return res.json({ ok: true, subscriberAddress, items });
    });

    app.post('/gc/onchain/unsubscribe', gcRequireJwt, async (req: any, res) => {
      const subscriberAddress = String(req.gcJwt?.address || '');
      const { address } = req.body ?? {};
      if (!subscriberAddress) return res.status(400).json({ ok: false, error: 'missing subscriber address' });
      if (!address) return res.status(400).json({ ok: false, error: 'missing address' });

      const repo = connection.getRepository(GcOnchainSubscription);
      await repo.delete({ subscriberAddress, address: String(address) } as any);

      return res.json({ ok: true, subscriberAddress, address: String(address) });
    });

    // simulate onchain event:
    // - confirmations 0 => unconfirmed push
    // - confirmations 1 => confirmed push (ONLY once)
    // - confirmations >=2 => NO push
    app.post('/gc/onchain/simulate', gcRequireJwt, async (req: any, res) => {
      const subscriberAddress = String(req.gcJwt?.address || '');
      const { address, txid, amountSat, confirmations } = req.body ?? {};

      if (!subscriberAddress) return res.status(400).json({ ok: false, error: 'missing subscriber address' });
      if (!address || !txid) return res.status(400).json({ ok: false, error: 'missing address/txid' });

      const conf = confirmations == null ? 0 : Number(confirmations);
      if (Number.isNaN(conf)) return res.status(400).json({ ok: false, error: 'confirmations must be number' });

      if (conf >= 2) {
        return res.json({ ok: true, sent: 0, note: 'confirmations>=2 -> no push' });
      }

      const status = conf >= 1 ? 'confirmed' : 'unconfirmed';

      const repo = connection.getRepository(GcOnchainSubscription);
      const subs = await repo.find({ where: { address: String(address) } as any });

      if (!subs.length) {
        return res.json({ ok: true, sent: 0, note: 'no subscribers for this address' });
      }

      // DATA-ONLY payload — client builds exact BW-like strings + overwrite by txid
      const data: Record<string, string> = {
        kind: 'gc_onchain',
        platform: 'android',
        channelId: 'bluewallet-notifications',
        address: String(address),
        txid: String(txid),
        amountSat: amountSat == null ? '' : String(amountSat),
        confirmations: String(conf),
        status,
      };

      const results: any[] = [];
      for (const s of subs) {
        try {
          const r = await gcSendPushToSubscriber(String((s as any).subscriberAddress), data);
          results.push({ subscriberAddress: (s as any).subscriberAddress, ok: true, results: (r as any).results ?? r });
        } catch (e: any) {
          results.push({ subscriberAddress: (s as any).subscriberAddress, ok: false, error: String(e?.message ?? e) });
        }
      }

      return res.json({ ok: true, sent: results.filter((x) => x.ok).length, results });
    });

    // ---------- existing app routes ----------
    Routes.forEach((route) => {
      (app as any)[route.method](route.route, (req: Request, res: Response, next: Function) => {
        const result = new (route.controller as any)(c)[route.action](req, res, next);
        if (result instanceof Promise) {
          result.then((result: any) => (result !== null && result !== undefined ? res.send(result) : undefined));
        } else if (result !== null && result !== undefined) {
          res.json(result);
        }
      });
    });

    // rate limiting (existing)
    app.set('trust proxy', 1);
    const rateLimit = require('express-rate-limit');
    const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
    app.use(limiter);

    const port = Number(process.env.PORT || 3000);
    if (!Number.isFinite(port)) {
      console.error('Invalid PORT in env:', process.env.PORT);
      process.exit(1);
    }

    app.listen(port, '0.0.0.0', () => {
      console.log('GroundControl server has started on port', port);
    });
  })
  .catch((error: any) => {
    console.log(error);
    process.exit(1);
  });
