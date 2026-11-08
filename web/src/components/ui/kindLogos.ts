// SPDX-License-Identifier: AGPL-3.0-only
import { type FunctionalComponent, h } from 'vue';
import dockerUrl from '@/assets/brands/docker.svg';
import kubernetesUrl from '@/assets/brands/kubernetes.svg';

// The Kubernetes and Docker logos as icon components, so they can stand wherever a lucide
// icon does (the cluster switcher, the cluster list, the add-cluster choice). The files are
// the owners' artwork, unchanged (TRADEMARKS.md, "Other marks"); they are images, never
// recoloured, and decorative: the cluster's kind is always written next to them.
function logo(name: 'kubernetes' | 'docker', src: string): FunctionalComponent {
  const component: FunctionalComponent = (_, { attrs }) =>
    h('img', {
      src,
      alt: '',
      'data-logo': name,
      draggable: false,
      width: 16,
      height: 16,
      ...attrs,
      class: ['object-contain', attrs.class],
    });
  component.inheritAttrs = false;
  return component;
}

export const KubernetesLogo = logo('kubernetes', kubernetesUrl);
export const DockerLogo = logo('docker', dockerUrl);
export const KIND_LOGO = { kubernetes: KubernetesLogo, docker: DockerLogo } as const;
