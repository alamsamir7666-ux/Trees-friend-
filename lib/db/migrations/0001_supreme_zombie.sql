CREATE INDEX "products_category_id_idx" ON "products" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "products_homepage_tag_deleted_idx" ON "products" USING btree ("homepage_tag","deleted_at");--> statement-breakpoint
CREATE INDEX "reviews_product_id_idx" ON "reviews" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "reviews_seller_listing_id_idx" ON "reviews" USING btree ("seller_listing_id");--> statement-breakpoint
CREATE INDEX "orders_user_id_created_idx" ON "orders" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "orders_seller_id_created_idx" ON "orders" USING btree ("seller_id","created_at");--> statement-breakpoint
CREATE INDEX "cart_items_user_id_idx" ON "cart_items" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "addresses_user_id_idx" ON "addresses" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "loyalty_transactions_user_id_created_idx" ON "loyalty_transactions" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "stock_alerts_variant_id_idx" ON "stock_alerts" USING btree ("variant_id");--> statement-breakpoint
CREATE INDEX "pre_orders_product_id_idx" ON "pre_orders" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "seller_listings_product_id_idx" ON "seller_listings" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "seller_listings_seller_id_idx" ON "seller_listings" USING btree ("seller_id");--> statement-breakpoint
CREATE INDEX "seller_listings_visibility_approval_idx" ON "seller_listings" USING btree ("visibility","approval_status");--> statement-breakpoint
CREATE INDEX "seller_listing_variants_seller_listing_id_idx" ON "seller_listing_variants" USING btree ("seller_listing_id");--> statement-breakpoint
CREATE INDEX "payouts_order_id_idx" ON "payouts" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "payouts_seller_id_created_idx" ON "payouts" USING btree ("seller_id","created_at");--> statement-breakpoint
ALTER TABLE "monthly_records" ADD CONSTRAINT "monthly_records_year_month_unique" UNIQUE("year","month");