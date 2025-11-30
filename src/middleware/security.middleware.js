import aj from '#config/arcjet.js';
import { slidingWindow } from '@arcjet/node';
import logger from '#config/logger.js';

const securityMiddleware = async (req, res, next) => {
  try {
    const role = req.user?.role || 'guest';

    let limit;
    let message;

    switch (role) {
      case 'admin':
        limit = 20
        message = 'Admin request limit exceeded 20 per minute, slow down'
        break;
      case 'user':
        limit = 10
        message = 'User request limit exceeded 10 per minute, slow down'
        break;
      case 'guest':
        limit = 5
        message = 'Guest request limit exceeded 5 per minute, slow down'
        break;
    }
        const client = aj.withRule(
          slidingWindow({
            mode: 'LIVE',
            interval: '1m',
            max: limit,
            name: `${role}-rate-limit`,
          })
        );

        const decision = await client.protect(req);
        if (decision.isDenied() && decision.reason.isBot()) {
          logger.warn('Bot request blocked', {
            ip: req.ip,
            userAgent: req.get('User-Agent'),
            path: req.path,
          });
          return res.status(483).json({
            error: 'Forbidden',
            message: 'Automated requests are not allowed',
          });
        }
        if (decision.isDenied() && decision.reason.isShield()) {
          logger.warn('Shield request blocked', {
            ip: req.ip,
            userAgent: req.get('User-Agent'),
            path: req.path,
          });
          return res.status(483).json({
            error: 'Forbidden',
            message: 'Request blocked by security policy',
          });
        }
        if (decision.isDenied() && decision.reason.isRateLimit()) {
          logger.warn('Rate limit exceeded', {
            ip: req.ip,
            userAgent: req.get('User-Agent'),
            path: req.path,
          });
          return res.status(483).json({
            error: 'Forbidden',
            message: 'Too many requests',
          });
        }

        next();
    } catch (e) {
    console.error('Security middleware error:', e);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Something went wrong with the security middleware',
    });
  }
};

export default securityMiddleware;
