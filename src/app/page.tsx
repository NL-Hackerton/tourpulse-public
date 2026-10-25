import { connection } from "next/server";
import TourConsole from "@/components/tour-console";

export default async function Home() {
  await connection();
  return <TourConsole />;
}
