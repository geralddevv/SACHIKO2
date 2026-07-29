import rateLimit, { ipKeyGenerator } from "express-rate-limit";

// Per-IP limiter for login (unauthenticated users)
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // Limit each IP to 20 login requests per window
  message: "Too many login attempts, please try again after 15 minutes",
  standardHeaders: true,
  legacyHeaders: false,
});

// Per-user limiters for authenticated data routes
export const createLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,
  message: "Too many create requests. Please try again later.",
  keyGenerator: (req, res) => {
    // Use authenticated user ID, fallback to IP if not authenticated
    return req.session?.authUser?.empId || ipKeyGenerator(req, res);
  },
  standardHeaders: true,
  legacyHeaders: false,
});

export const updateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30,
  message: "Too many update requests. Please try again later.",
  keyGenerator: (req, res) => {
    // Use authenticated user ID, fallback to IP if not authenticated
    return req.session?.authUser?.empId || ipKeyGenerator(req, res);
  },
  standardHeaders: true,
  legacyHeaders: false,
});

export const deleteLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5,
  message: "Too many delete requests. Please try again later.",
  keyGenerator: (req, res) => {
    // Use authenticated user ID, fallback to IP if not authenticated
    return req.session?.authUser?.empId || ipKeyGenerator(req, res);
  },
  standardHeaders: true,
  legacyHeaders: false,
});
