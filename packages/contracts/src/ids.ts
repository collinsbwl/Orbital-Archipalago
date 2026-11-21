import { z } from 'zod';

// Ids are plain strings validated by regex (no brands: keeps fixtures and JSON simple).
const slug = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);

export const PlanetIdSchema = slug;
export type PlanetId = string;
export const GoodIdSchema = slug;
export type GoodId = string;
export const RecipeIdSchema = slug;
export type RecipeId = string;
export const CurrencyIdSchema = z.string().regex(/^[A-Z]{2,5}$/);
export type CurrencyId = string;
/** e.g. `helion:colonist:7`. */
export const AgentIdSchema = z.string().regex(/^[a-z0-9_:-]{1,64}$/);
export type AgentId = string;
export const UniverseIdSchema = z.string().regex(/^[a-z0-9_-]{1,64}$/);
export type UniverseId = string;
export const OrderIdSchema = z.string().min(1).max(64);
export type OrderId = string;
export const ShipmentIdSchema = z.string().min(1).max(64);
export type ShipmentId = string;
export const LoanIdSchema = z.string().min(1).max(64);
export type LoanId = string;
/** A purse/inventory holder: an agent id or a planet id (its treasury). */
export type OwnerId = AgentId | PlanetId;

// Amounts: integers only, as JS numbers bounded to the safe-integer range.
/** Currency amount in minor units (>= 0). */
export const MinorUnitsSchema = z.number().int().safe().nonnegative();
export type MinorUnits = number;
/** Signed minor units (trade balance, series values). */
export const SignedMinorUnitsSchema = z.number().int().safe();
export type SignedMinorUnits = number;
/** Positive count of goods units. */
export const QtySchema = z.number().int().safe().positive();
export type Qty = number;
/** Non-negative count of goods units (stocks, volumes). */
export const StockSchema = z.number().int().safe().nonnegative();
export type Stock = number;
/** Basis points, 10_000 = 100%. */
export const RateBpSchema = z.number().int().min(0).max(10_000);
export type RateBp = number;
/** Signed basis points (shocks). */
export const SignedBpSchema = z.number().int().min(-10_000).max(10_000);
export type SignedBp = number;
/** Cycle counter. */
export const CycleSchema = z.number().int().nonnegative();
/** FX rates are integer ppm: quote minor units per base minor unit, times RATE_SCALE. */
export const RATE_SCALE = 1_000_000;
export const RatePpmSchema = z.number().int().safe().positive();
export type RatePpm = number;
