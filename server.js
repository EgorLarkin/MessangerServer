import SwiftUI
import UIKit

struct ShareSheet: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> HostViewController {
        HostViewController(items: items)
    }

    func updateUIViewController(_ uiViewController: HostViewController, context: Context) {
        uiViewController.items = items
        uiViewController.presentIfNeeded()
    }

    final class HostViewController: UIViewController {
        var items: [Any]
        private var didPresent = false

        init(items: [Any]) {
            self.items = items
            super.init(nibName: nil, bundle: nil)
        }

        required init?(coder: NSCoder) {
            fatalError("init(coder:) has not been implemented")
        }

        override func viewDidAppear(_ animated: Bool) {
            super.viewDidAppear(animated)
            presentIfNeeded()
        }

        func presentIfNeeded() {
            guard !didPresent, view.window != nil else { return }
            let validItems = items.filter { !($0 is Optional<Any>) }
            guard !validItems.isEmpty else { return }

            didPresent = true
            let controller = UIActivityViewController(activityItems: validItems, applicationActivities: nil)

            if let popover = controller.popoverPresentationController {
                popover.sourceView = view
                popover.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 1, height: 1)
            }

            present(controller, animated: true)
        }
    }
}
