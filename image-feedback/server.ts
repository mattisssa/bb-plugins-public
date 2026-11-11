import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { feedbackMessage, rpcContract } from "./shared";

export default function plugin(bb: BbPluginApi): void {
  bb.rpc.register(rpcContract, {
    async sendImageFeedback({ threadId, source, image, notes }) {
      const bytes = Buffer.from(image.base64, "base64");
      const png = bytes.subarray(0, 4).equals(Buffer.from([137, 80, 78, 71]));
      const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
      if (image.mimeType === "image/png" ? !png : !jpeg)
        throw new Error("The marked-up image is not a valid PNG or JPEG.");
      // A project attachment is the one place the chat can show an image from.
      const { projectId } = await bb.sdk.threads.get({ threadId });
      const { path } = await bb.sdk.projects.attachments.upload({
        projectId,
        clientFile: new Uint8Array(bytes),
        filename: `image-feedback-${Date.now()}.${png ? "png" : "jpg"}`,
        mimeType: image.mimeType,
      });
      const { summary, details } = feedbackMessage({ source, image, notes });
      await bb.sdk.threads.send({
        threadId,
        mode: "auto",
        input: [
          { type: "text", text: summary, mentions: [] },
          {
            type: "text",
            text: `\n${details}`,
            mentions: [],
            visibility: "agent-only",
          },
          { type: "localImage", path },
        ],
      });
      return null;
    },
  });
}
