// SPDX-License-Identifier: AGPL-3.0-only
// A Java service for the Servers tests: listens on :8093 and answers every connection.
import java.io.OutputStream;
import java.net.ServerSocket;
import java.net.Socket;

public class Billing {
  public static void main(String[] args) throws Exception {
    try (ServerSocket server = new ServerSocket(8093)) {
      while (true) {
        try (Socket s = server.accept(); OutputStream out = s.getOutputStream()) {
          out.write("HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nok\n".getBytes());
        }
      }
    }
  }
}
