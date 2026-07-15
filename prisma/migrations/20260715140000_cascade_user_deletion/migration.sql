-- Removing an account is an explicit destructive administrator action. Its billing
-- records and user-owned webhooks must be removed with the rest of the account.
ALTER TABLE "BillingOrder" DROP CONSTRAINT "BillingOrder_userId_fkey";
ALTER TABLE "BillingOrder"
ADD CONSTRAINT "BillingOrder_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PaymentEvent" DROP CONSTRAINT "PaymentEvent_orderId_fkey";
ALTER TABLE "PaymentEvent"
ADD CONSTRAINT "PaymentEvent_orderId_fkey"
FOREIGN KEY ("orderId") REFERENCES "BillingOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Webhook" DROP CONSTRAINT "Webhook_userId_fkey";
ALTER TABLE "Webhook"
ADD CONSTRAINT "Webhook_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
