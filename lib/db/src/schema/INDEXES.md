# Recommended Database Indexes

Run these migrations to add critical indexes for production performance.

## Why These Indexes Matter

Without these indexes, every filtered query performs a sequential scan (O(n) time).
With indexes, queries become O(log n) — critical at 100k+ rows.

## SQL Migrations to Run

```sql
-- ─── Products ────────────────────────────────────────────────────────────────

-- Fast category filtering (most common query pattern)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_products_category
  ON products(category);

-- Fast homepage section queries
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_products_homepage_section
  ON products(homepage_section)
  WHERE homepage_section IS NOT NULL;

-- Fast featured products query
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_products_is_featured
  ON products(is_featured)
  WHERE is_featured = true;

-- Fast category + created_at for sorted product listings
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_products_category_created
  ON products(category, created_at DESC);

-- Full-text search on product name (ilike queries)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_products_name_trgm
  ON products USING gin(name gin_trgm_ops);
-- Requires: CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ─── Reviews ─────────────────────────────────────────────────────────────────

-- Fast lookup of reviews per product (used in fetchReviewStats)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_reviews_product_id
  ON reviews(product_id);

-- Fast check for user's existing review (duplicate prevention)
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_reviews_user_product
  ON reviews(product_id, user_id);

-- ─── Orders ──────────────────────────────────────────────────────────────────

-- Fast user order history
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_orders_user_id
  ON orders(user_id, created_at DESC);

-- Fast order status filtering (admin dashboard)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_orders_status
  ON orders(order_status, created_at DESC);

-- Fast tracking ID lookup
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_orders_tracking_id
  ON orders(tracking_id);

-- Monthly analytics query optimization
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_orders_created_at
  ON orders(created_at DESC);

-- ─── Cart ────────────────────────────────────────────────────────────────────

-- Fast cart lookup per user (most frequent query)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cart_items_user_id
  ON cart_items(user_id);

-- Fast single item lookup (add to cart / update quantity)
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_cart_items_user_product
  ON cart_items(user_id, product_id);

-- ─── Users ───────────────────────────────────────────────────────────────────

-- Fast Clerk ID lookup (used on every authenticated request)
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_users_clerk_id
  ON users(clerk_id);

-- Fast email lookup
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_email
  ON users(email);

-- ─── Addresses ───────────────────────────────────────────────────────────────

-- Fast address lookup per user
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_addresses_user_id
  ON addresses(user_id);

-- ─── Wishlist ────────────────────────────────────────────────────────────────

-- Fast wishlist lookup per user
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_wishlist_user_id
  ON wishlist(user_id);

-- Fast wishlist item check (product in user's wishlist?)
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_wishlist_user_product
  ON wishlist(user_id, product_id);

-- ─── Coupons ─────────────────────────────────────────────────────────────────

-- Fast coupon code lookup (case-insensitive, always uppercase stored)
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_coupons_code
  ON coupons(code);
```

## Notes

- Use `CONCURRENTLY` on production to avoid locking tables
- `pg_trgm` extension enables fast ILIKE (fuzzy search) on product names
- Run `ANALYZE products;` after creating indexes to update query planner statistics
- Monitor with: `SELECT * FROM pg_stat_user_indexes ORDER BY idx_scan DESC;`
