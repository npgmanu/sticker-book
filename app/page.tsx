import StickerBook from "./sticker-book";

export const dynamic = "force-dynamic";

export default async function Home() {
  return <StickerBook viewer={{ name: "Guest Collector", email: "", signedIn: false }} />;
}
