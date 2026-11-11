import { productRegistryV1 } from "@aurelia/core";
import { PrivateFeedback } from "@/components/website/participation";
import { featureText } from "@/components/website/product-copy";
import styles from "@/components/website/product-pages.module.css";

export const metadata = { title: "Обратная связь — Aurelia" };
export default function FeedbackPage() {
  return (
    <article className={styles.page}>
      <p className={styles.eyebrow}>Обратная связь</p>
      <h1>Что можно сделать лучше?</h1>
      <p>
        Сообщите об ошибке или предложите функцию. Ваши обращения видны только в
        вашем аккаунте и не попадают в публичную ленту. Не добавляйте пароли,
        коды доступа и другие секреты.
      </p>
      <PrivateFeedback
        features={productRegistryV1.features.map((feature) => ({
          id: feature.id,
          title: featureText(feature).title,
        }))}
      />
    </article>
  );
}
