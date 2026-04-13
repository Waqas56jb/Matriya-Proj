/**
 * Authentication utilities
 */
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { User } from './database.js';

// JWT settings
const SECRET_KEY = process.env.JWT_SECRET || crypto.randomBytes(32).toString('base64');
const ALGORITHM = "HS256";
const ACCESS_TOKEN_EXPIRE_MINUTES = 30 * 24 * 60; // 30 days

export const ACCESS_TOKEN_EXPIRE_MINUTES_EXPORT = ACCESS_TOKEN_EXPIRE_MINUTES;

/**
 * Verify a password against its hash
 */
export function verifyPassword(plainPassword, hashedPassword) {
  return bcrypt.compareSync(plainPassword, hashedPassword);
}

/**
 * Hash a password
 */
export function getPasswordHash(password) {
  return bcrypt.hashSync(password, 10);
}

/**
 * Create a JWT access token
 */
export function createAccessToken(data, expiresDelta = null) {
  const toEncode = { ...data };
  const expire = expiresDelta 
    ? new Date(Date.now() + expiresDelta * 60 * 1000)
    : new Date(Date.now() + ACCESS_TOKEN_EXPIRE_MINUTES * 60 * 1000);
  
  toEncode.exp = Math.floor(expire.getTime() / 1000);
  return jwt.sign(toEncode, SECRET_KEY, { algorithm: ALGORITHM });
}

/**
 * Verify and decode a JWT token
 */
export function verifyToken(token) {
  try {
    return jwt.verify(token, SECRET_KEY, { algorithms: [ALGORITHM] });
  } catch (e) {
    return null;
  }
}

/**
 * Get user by username
 */
export async function getUserByUsername(username) {
  if (!User) {
    throw new Error("Database not initialized. User model is not available.");
  }
  return await User.findOne({ where: { username } });
}

/**
 * Get user by email
 */
export async function getUserByEmail(email) {
  if (!User) {
    throw new Error("Database not initialized. User model is not available.");
  }
  return await User.findOne({ where: { email } });
}

/**
 * Authenticate a user
 */
export async function authenticateUser(username, password) {
  const user = await getUserByUsername(username);
  if (!user) {
    return null;
  }
  if (!verifyPassword(password, user.hashed_password)) {
    return null;
  }
  if (!user.is_active) {
    return null;
  }
  return user;
}

/**
 * Create a new user
 */
export async function createUser(username, email, password, fullName = null) {
  if (!User) {
    throw new Error("Database not initialized. User model is not available.");
  }
  const hashedPassword = getPasswordHash(password);
  const user = await User.create({
    username,
    email,
    hashed_password: hashedPassword,
    full_name: fullName,
    is_active: true,
    is_admin: false
  });
  return user;
}
