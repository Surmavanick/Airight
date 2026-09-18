import { handleStatus } from "../lib/cloud-api.mjs";

export default {
  fetch(request) {
    return handleStatus(request);
  },
};
