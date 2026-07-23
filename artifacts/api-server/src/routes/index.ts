import smsWebhookRouter from "./smsWebhook";
import { Router, type IRouter } from "express";
import healthRouter from "./health";
import productsRouter from "./products";
import cartRouter from "./cart";
import ordersRouter from "./orders";
import reviewsRouter from "./reviews";
import wishlistRouter from "./wishlist";
import couponsRouter from "./coupons";
import usersRouter from "./users";
import adminRouter from "./admin";
import categoriesRouter from "./categories";
import monthlyRecordsRouter from "./monthlyRecords";
import abandonedCartRouter from "./abandonedCart";
import referralsRouter from "./referrals";
import loyaltyRouter from "./loyalty";
import stockAlertsRouter from "./stockAlerts";
import preOrdersRouter from "./preOrders";
import newsletterRouter from "./newsletter";
import auditLogsRouter from "./auditLogs";
import productQARouter from "./productQA";
import sitemapRouter from "./sitemap";
import exportRouter from "./export";
import returnsRouter from "./returns";
import variantsRouter from "./variants";
import bulkImportRouter from "./bulkImport";
import affiliatesRouter from "./affiliates";
import analyticsRouter from "./analytics";
import pushRouter from "./push";
import subscriptionsRouter from "./subscriptions";
import giftCardsRouter from "./giftCards";
import emailPreferencesRouter from "./emailPreferences";
import searchRouter from "./search";
// flashSales router removed in Phase 2: flash sales were entirely
// productVariantsTable-based (products tagged homepageTag="flash" with a
// discounted admin variant) with no seller/marketplace ownership concept
// at all. Admin no longer creates productVariantsTable rows as of this
// phase, so this endpoint would have silently returned [] forever going
// forward. A site-wide "flash sale" also has no clean single-seller owner
// in a marketplace -- a discount is now a per-seller-listing-variant
// decision (sellerListingVariantsTable.discountPrice), not a
// product-wide/platform-wide one. Deleting rather than adapting: see
// PHASE2_HANDOFF.md for the full reasoning and the frontend components
// this leaves needing attention (FlashSaleSection.tsx, FlashSaleBanner.tsx,
// their reference in App.tsx) -- not fixed here, Phase 3's job, flagged.
import blogPostsRouter from "./blogPosts";
import mobileAuthRouter from "./mobileAuth";
import assetsRouter from "./assets";
import homepageSectionsRouter from "./homepageSections";
import sellerSubscriptionsRouter from "./sellerSubscriptions";
import sellersRouter from "./sellers";
import adminSellersRouter from "./adminSellers";
import sellerListingsRouter from "./sellerListings";
import listingAttributeOptionsRouter from "./listingAttributeOptions";
import sellerCourierConfigsRouter from "./sellerCourierConfigs";
import sellerPaymentConfigsRouter from "./sellerPaymentConfigs";
import orderShipmentsRouter from "./orderShipments";
import sellerOrdersRouter from "./sellerOrders";
import courierWebhooksRouter from "./courierWebhooks";

const router: IRouter = Router();

router.use(healthRouter);
router.use(mobileAuthRouter);
router.use(categoriesRouter);
router.use(productsRouter);
router.use(cartRouter);
router.use(ordersRouter);
router.use(reviewsRouter);
router.use(wishlistRouter);
router.use(couponsRouter);
router.use(usersRouter);
router.use(adminRouter);
router.use(monthlyRecordsRouter);
router.use(abandonedCartRouter);
router.use(referralsRouter);
router.use(loyaltyRouter);
router.use(stockAlertsRouter);
router.use(preOrdersRouter);
router.use(newsletterRouter);
router.use(auditLogsRouter);
router.use(productQARouter);
router.use(sitemapRouter);
router.use(exportRouter);
router.use(returnsRouter);
router.use(variantsRouter);
router.use(bulkImportRouter);
router.use(affiliatesRouter);
router.use(analyticsRouter);
router.use(pushRouter);
router.use(subscriptionsRouter);
router.use(giftCardsRouter);
router.use(emailPreferencesRouter);
router.use(searchRouter);
router.use(blogPostsRouter);
router.use(assetsRouter);
router.use(homepageSectionsRouter);
router.use(sellerSubscriptionsRouter);
router.use(sellersRouter);
router.use(adminSellersRouter);
router.use(sellerListingsRouter);
router.use(listingAttributeOptionsRouter);
router.use(sellerCourierConfigsRouter);
router.use(sellerPaymentConfigsRouter);
router.use(orderShipmentsRouter);
router.use(sellerOrdersRouter);
router.use(courierWebhooksRouter);

export default router;
