import { handleDetection } from "../../lib/cloud-api.mjs";

export default {
  fetch(request) {
    return handleDetection(request);
  },
};
