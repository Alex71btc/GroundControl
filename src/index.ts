import 'reflect-metadata';
import * as express from 'express';
import * as bodyParser from 'body-parser';
import { Request, Response } from 'express';
import { Routes } from './routes';
import dataSource from './data-source';
import { DataSource } from 'typeorm';

import { GcPushToken } from './entity/GcPushToken';
import { GcOnchainSubscription } from './entity/GcOnchainSubscription';

require('dotenv').config();
const cors = require('cors');
const helmet = require('helmet');
const jwt = require('jsonwebtoken');
const bitcoinMessage = require('bitcoinjs-message');
const admin = require('firebase-admin');

if (!process.env.JAWSDB_MARIA_URL || !process.env.GOOGLE_KEY_FILE || !process.env.GC_JWT_SECRET) {
  console.error('not all env variables set');
  process.exit(1);
}

const GC_NONCE_TTL_MS = 120 * 1000;
const gcNonces = new Map<string, number>();

let connection: DataSource;

/**
 * JWT middleware
 */
const gcRequireJwt = (req: any, res: any, next: any) => {
  const h = String(req.headers?.authorization || '');
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return res.status(401).json({ ok: false, error: 'missing authorization header' });

  try {
    const payload = jwt.verify(m[1], process.env.GC_JWT_SECRET);
    req.gcJwt = payload;
    return next();
  } catch (e: any) {
    return res.status(401).json({ ok: false, error: `invalid token: ${String(e?.message ?? e)}` });
  }
};

/**
 * Firebase Admin init
 */
if (!admin.apps.length) {
  const serviceAccount = require(process.env.GOOGLE_KEY_FILE);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
  console.log('[GC] Firebase Admin initialized');
}

/**
 * Helper: send a push to a subscriber identity (subscriberAddress) using their registered device token.
 *
 * IMPORTANT:
 * - Use FCM "notification" payload so Android shows it even if the app is not running.
 * - Still include "data" so the app can react to taps / open details.
 */
const gcSendPushToSubscriber = async (
  subscriberAddress: string,
  title: string,
  message: string,
  data: Record<string, string> = {},
) => {
  const tokenRepo = connection.getRepository(GcPushToken);
  const tokenEntry = await tokenRepo.findOne({ where: { address: subscriberAddress, platform: 'android' } as any });

  if (!tokenEntry?.token) {
    return { ok: false, error: 'no push token for subscriber' };
  }

  const msg: any = {
    token: tokenEntry.token,

    // System-rendered notification (reliable even if app not running)
    notification: {
      title: String(title),
      body: String(message),
    },

    android: {
      priority: 'high',
      notification: {
        channelId: 'bluewallet-notifications',
        // must exist in android/app/src/main/res/drawable* (or mipmap*)
        icon: 'ic_notification',
      },
    },

    // Keep data for app-side processing / deep links
    data: {
      kind: 'gc_onchain',
      title: String(title),
      message: String(message),
      channelId: 'bluewallet-notifications',
      ...Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
    },
  };

  const messageId = await admin.messaging().send(msg);
  return { ok: true, messageId };
};

dataSource
  .initialize()
  .then(async c => {
    console.log('db connected');
    connection = c;

    const app = express();
    app.use(bodyParser.json());
    app.use(cors());
    app.use(helmet.hidePoweredBy());
    app.use(helmet.hsts());

    // -------------------------
    // Basic endpoints
    // -------------------------
    app.get('/health', (_req, res) => res.status(200).send('ok'));

    app.get('/gc/info', (_req, res) => {
      res.json({
        name: 'GroundControl',
        version: process.env.npm_package_version ?? 'dev',
        time: new Date().toISOString(),
      });
    });

    // -------------------------
    // Auth (nonce + verify -> JWT)
    // -------------------------
    app.post('/gc/auth/nonce', (_req, res) => {
      const nonce = Math.random().toString(36).slice(2);
      const expiresAt = Date.now() + GC_NONCE_TTL_MS;
      gcNonces.set(nonce, expiresAt);
      res.json({ nonce, expiresInSec: Math.floor(GC_NONCE_TTL_MS / 1000) });
    });

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

      // one-time use
      gcNonces.delete(String(nonce));

      try {
        const verified = bitcoinMessage.verify(String(nonce), String(address), String(signature));
        if (!verified) return res.status(401).json({ ok: false, verified: false });

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

    app.get('/gc/ping-auth', gcRequireJwt, (req: any, res) => {
      res.json({
        ok: true,
        pong: true,
        address: req.gcJwt?.address,
        time: new Date().toISOString(),
      });
    });

    // -------------------------
    // Push token register / list
    // -------------------------
    app.post('/gc/push/register', gcRequireJwt, async (req: any, res) => {
      const address = String(req.gcJwt?.address || '').trim();
      const platform = String(req.body?.platform || '').trim();
      const token = String(req.body?.token || '').trim();

      if (!address) return res.status(400).json({ ok: false, error: 'missing jwt address' });
      if (!platform) return res.status(400).json({ ok: false, error: 'missing platform' });
      if (!token) return res.status(400).json({ ok: false, error: 'missing token' });

      const repo = connection.getRepository(GcPushToken);

      await repo.save({
        address,
        platform,
        token,
      } as any);

      return res.json({ ok: true, address, platform });
    });

    app.get('/gc/push/me', gcRequireJwt, async (req: any, res) => {
      const address = String(req.gcJwt?.address || '').trim();
      const repo = connection.getRepository(GcPushToken);
      const items = await repo.find({ where: { address } as any, order: { updatedAt: 'DESC' } as any });
      return res.json({ ok: true, address, items });
    });

    app.post('/gc/push/test', gcRequireJwt, async (req: any, res) => {
      const address = String(req.gcJwt?.address || '').trim();
      const title = String(req.body?.title || 'GC Test');
      const body = String(req.body?.body || 'Hello');

      try {
        const r = await gcSendPushToSubscriber(address, title, body, {
          kind: 'gc_test',
          address,
        });
        return res.json({ ok: true, ...r });
      } catch (e: any) {
        return res.status(500).json({ ok: false, error: String(e?.message ?? e) });
      }
    });

    // -------------------------
    // Onchain subscriptions
    // -------------------------
    app.post('/gc/onchain/subscribe', gcRequireJwt, async (req: any, res) => {
      const subscriberAddress = String(req.gcJwt?.address || '').trim();
      const address = String(req.body?.address || '').trim();
      if (!subscriberAddress) return res.status(400).json({ ok: false, error: 'missing jwt address' });
      if (!address) return res.status(400).json({ ok: false, error: 'missing address' });

      const repo = connection.getRepository(GcOnchainSubscription);
      await repo.save({ subscriberAddress, address } as any);

      return res.json({ ok: true, subscriberAddress, address });
    });

    app.get('/gc/onchain/subscriptions', gcRequireJwt, async (req: any, res) => {
      const subscriberAddress = String(req.gcJwt?.address || '').trim();
      if (!subscriberAddress) return res.status(400).json({ ok: false, error: 'missing jwt address' });

      const repo = connection.getRepository(GcOnchainSubscription);
      const items = await repo.find({ where: { subscriberAddress } as any, order: { updatedAt: 'DESC' } as any });
      return res.json({ ok: true, subscriberAddress, items });
    });

    app.post('/gc/onchain/unsubscribe', gcRequireJwt, async (req: any, res) => {
      const subscriberAddress = String(req.gcJwt?.address || '').trim();
      const address = String(req.body?.address || '').trim();
      if (!subscriberAddress) return res.status(400).json({ ok: false, error: 'missing jwt address' });
      if (!address) return res.status(400).json({ ok: false, error: 'missing address' });

      const repo = connection.getRepository(GcOnchainSubscription);
      await repo.delete({ subscriberAddress, address } as any);
      return res.json({ ok: true, subscriberAddress, address });
    });

    // Simulate on-chain event -> push to all subscribers of that address
    app.post('/gc/onchain/simulate', gcRequireJwt, async (req: any, res) => {
      const address = String(req.body?.address || '').trim();
      const txid = String(req.body?.txid || 'dummy_txid').trim();
      const amountSatNum = Number(req.body?.amountSat ?? 0);
      const amountSat = Number.isFinite(amountSatNum) ? Math.max(0, Math.floor(amountSatNum)) : 0;
      const confirmationsNum = Number(req.body?.confirmations ?? 0);
      const confirmations = Number.isFinite(confirmationsNum) ? Math.max(0, Math.floor(confirmationsNum)) : 0;

      if (!address) return res.status(400).json({ ok: false, error: 'missing address' });

      // BlueWallet-like address shortening
      const shortAddr = (a: string) => (a.length > 12 ? `${a.slice(0, 5)}…${a.slice(-4)}` : a);
      const addrShort = shortAddr(address);

      const status = confirmations >= 1 ? 'confirmed' : 'unconfirmed';

      // BlueWallet-like text (1:1 style)
      const title = confirmations >= 1 ? `+${amountSat} sats` : 'New unconfirmed transaction';
      const message = confirmations >= 1 ? `Received on ${addrShort}` : `You received new transfer on\n${addrShort}`;

      const subRepo = connection.getRepository(GcOnchainSubscription);
      const subs = await subRepo.find({ where: { address } as any });

      if (!subs.length) return res.json({ ok: true, sent: 0, note: 'no subscribers for this address' });

      const results: any[] = [];
      for (const s of subs) {
        try {
          const r = await gcSendPushToSubscriber(s.subscriberAddress, title, message, {
            kind: 'gc_onchain',
            status,
            address,
            txid,
            amountSat: String(amountSat),
            confirmations: String(confirmations),
          });
          results.push({ subscriberAddress: s.subscriberAddress, ...r });
        } catch (e: any) {
          results.push({ subscriberAddress: s.subscriberAddress, ok: false, error: String(e?.message ?? e) });
        }
      }

      return res.json({ ok: true, sent: results.filter(x => x.ok).length, results });
    });

    // -------------------------
    // Register express routes (existing app)
    // -------------------------
    Routes.forEach(route => {
      (app as any)[route.method](route.route, (req: Request, res: Response, next: Function) => {
        const result = new (route.controller as any)(c)[route.action](req, res, next);
        if (result instanceof Promise) {
          result.then((result: any) => (result !== null && result !== undefined ? res.send(result) : undefined));
        } else if (result !== null && result !== undefined) {
          res.json(result);
        }
      });
    });

    app.set('trust proxy', 1);
    const rateLimit = require('express-rate-limit');
    const limiter = rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 100,
    });
    app.use(limiter);

    // keep your port behavior
    app.listen(process.env.PORT || 3000);

    console.log('GroundControl server has started on port ', process.env.PORT || 3000);
  })
  .catch((error: any) => console.log(error));
