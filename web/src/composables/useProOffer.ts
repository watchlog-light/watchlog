// SPDX-License-Identifier: AGPL-3.0-only
// How every page offers Pro (ADR-205, amended in 0.9.5), Cloud only: one rule, so no page
// says Pro is free when it isn't.
//   - the price from GET /plan: "Upgrade to Pro: $3 per node or server a month, $15 minimum";
//   - without a price (the plan isn't read yet): "Upgrade to Pro", with no amount;
//   - the beta's free Pro only while the billing service itself says it is reachable and
//     not live. Billing out of reach, or not asked yet, is never read as "free".
// The plan strip, the over-limit banner, the plan-limit messages of Add cluster, the wizard
// and invites, and the first week's card all read it.
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { planLimitKind } from '@/api/cloud';
import { money } from '@/lib/what-changed-upgrade';
import { usePlanStore } from '@/stores/plan';

export function useProOffer() {
  const { t } = useI18n();
  const plan = usePlanStore();

  const beta = computed(() => plan.betaOpen);
  const price = computed(() => {
    const p = plan.info?.price;
    return p
      ? {
          perNode: money(p.perNodeMonth, p.currency),
          minimum: money(p.minimumMonth, p.currency),
        }
      : null;
  });
  /** The link's words: "Upgrade to Pro · $3 per node →". */
  const link = computed(() =>
    beta.value
      ? t('cloud.plan.tryPro')
      : price.value
        ? t('cloud.plan.upgradePro', { perNode: price.value.perNode })
        : t('cloud.plan.upgradeProPlain'),
  );
  /** One sentence that offers Pro and says where. */
  const sentence = computed(() =>
    beta.value
      ? t('cloud.plan.offer.beta')
      : price.value
        ? t('cloud.plan.offer.price', price.value)
        : t('cloud.plan.offer.plain'),
  );
  /**
   * The message for a 409/402 `plan-limit` (ADR-177) in plain words, or null for any other
   * error. An org already on a paid plan isn't offered Pro.
   */
  function limitMessage(err: unknown): string | null {
    const kind = planLimitKind(err);
    if (!kind) return null;
    const paid = !!plan.info && plan.info.plan !== 'free';
    if (paid) return t(`cloud.plan.limitError.paid.${kind}`);
    return t(`cloud.plan.limitError.${kind}`, { offer: sentence.value });
  }
  /**
   * The same, for a page outside the shell (the wizard), where nothing has read the plan yet:
   * reads it first, so the refusal carries the price.
   */
  async function limitMessageFresh(err: unknown): Promise<string | null> {
    if (planLimitKind(err) && !plan.loaded) await plan.load();
    return limitMessage(err);
  }
  return { beta, price, link, sentence, limitMessage, limitMessageFresh };
}
