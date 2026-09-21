import { store } from "../store.ts";
import type { Routes } from "./types.ts";

export const notificationRoutes: Routes = {
  "notifications.read": (event) => {
    store.readNotifications(event.ids);
  },
  "notifications.clear": () => {
    store.clearNotifications();
  },
  "notifications.configure": (event) => {
    store.configureNotifications(event.preferences);
  },
};
