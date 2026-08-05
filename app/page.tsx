import { getChatGPTUser } from "./chatgpt-auth";
import StickerBook from "./sticker-book";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await getChatGPTUser();

  return (
    <StickerBook
      viewer={
        user
          ? { name: user.displayName, email: user.email, signedIn: true }
          : { name: "Guest Collector", email: "", signedIn: false }
      }
    />
  );
}
