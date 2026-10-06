import jwt from 'jsonwebtoken';
import { ROLES } from './domain.js';

export function authenticate(req, res, next) {
  const token = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = { id: payload.sub, role: payload.role, name: payload.name, email: payload.email };
    return next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

export const allowRoles = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) return res.status(403).json({ error: 'You do not have permission to perform this action' });
  return next();
};

export const adminOnly = allowRoles(ROLES.ADMIN);
export const salesOnly = allowRoles(ROLES.SALES);
export const salesOrAdmin = allowRoles(ROLES.SALES, ROLES.ADMIN);
