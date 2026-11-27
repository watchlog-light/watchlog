// SPDX-License-Identifier: AGPL-3.0-only
// What a service page's panels need to link (1.1.0): its id and its cluster's, provided by the
// page and the queue's page, injected by the panels.
import { inject, type InjectionKey } from 'vue';

export interface ServicePageContext {
  appId: string;
  clusterId: string;
}
export const SERVICE_PAGE: InjectionKey<ServicePageContext> = Symbol('service-page');
export const useServicePage = () => inject(SERVICE_PAGE, { appId: '', clusterId: '' });
